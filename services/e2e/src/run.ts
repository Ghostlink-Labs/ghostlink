/**
 * The localnet end-to-end (build plan, test layer 4 — on a REAL
 * validator, through the REAL services, using the REAL SDK):
 *
 *   1. initialize both trees
 *   2. register a wallet through the relayer (true secret derivation:
 *      s = SHA-256 of the wallet's deterministic signature)
 *   3. census snapshot through the relayer; indexer ingests from RPC
 *   4. prove login on this machine (snarkjs, dev keys)
 *   5. verify the proof server-side with @ghostlink/verify
 *   6. open the pocket session through the relayer
 *   7. fund the pocket through the Actions (Blink) endpoint
 *   8. fill through the solver (inventory, or cloned Jupiter with the fork fixture)
 *   9. sweep home with an owner proof through the relayer
 *
 * Expects a validator prepared by scripts/localnet-e2e.sh.
 */
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import * as snarkjs from "snarkjs";

import {
  bytesToHex,
  hexToBytes,
  appId as deriveAppId,
  domainHash as deriveDomainHash,
  fieldToBytes32,
  hashToField,
  proofToBytes,
  publicSignalsToBytes,
  type Policy,
  type SnarkjsProof,
} from "@ghostlink/common";
import {
  GhostLink,
  buildLoginInput,
  buildRegistration,
  deriveIdentity,
  sessionPublicKey,
  sweepDigest,
  revokeDigest,
  type Prover,
} from "@ghostlink/sdk";
import { verifyLogin } from "@ghostlink/verify";
import {
  REGISTRY,
  ataAddress,
  createAtaIdempotentIx,
  initializeIx,
  initializeMint2Ix,
  mintToIx,
  pocketPda,
  readPocketAccount,
} from "@ghostlink/service-kit";
import { IndexerStore } from "@ghostlink/indexer/store";
import { buildServer as buildIndexer } from "@ghostlink/indexer/server";
import { Poller } from "@ghostlink/indexer/poller";
import { buildServer as buildRelayer } from "@ghostlink/relayer/server";
import { buildServer as buildActions } from "@ghostlink/actions/server";
import { label, priceAccountFor } from "./genesis.js";
import { startBotFixture } from "./bot-session.js";
import { startSolverFixture } from "./solver-session.js";
import { JupiterForkPlanner, loadJupiterFixture, syncNative } from "./jupiter-fixture.js";
import { exerciseJupiterPocket } from "./jupiter-pocket.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const ROOT = process.env.REPO_ROOT ?? join(process.cwd(), "..", "..");
let botFixture: Awaited<ReturnType<typeof startBotFixture>> | undefined;
let solverFixture: Awaited<ReturnType<typeof startSolverFixture>> | undefined;

const ok = (step: string) => console.log(`✓ ${step}`);

const keepRunning = process.env.GHOSTLINK_KEEP_RUNNING === "1";
const demoPortBase = Number(process.env.GHOSTLINK_DEMO_PORT_BASE ?? 8787);
async function listen(server: Server, demoPort: number): Promise<string> {
  if (!Number.isInteger(demoPortBase) || demoPortBase < 1 || demoPortBase > 65532) {
    throw new Error("GHOSTLINK_DEMO_PORT_BASE must be between 1 and 65532");
  }
  server.listen(keepRunning ? demoPortBase + demoPort - 8787 : 0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

async function main() {
  // This candidate has no verified public deployment. Refuse before loading
  // any funded key or sending any transaction, even when RPC_URL is mislabeled.
  if (process.env.PAYER_KEYPAIR) throw new Error("V2 E2E is disposable-localnet only; funded payer keys are not accepted");
  const rpcHost = new URL(RPC).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(rpcHost)) throw new Error("V2 E2E requires a loopback local validator");
  const connection = new Connection(RPC, "confirmed");
  if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(await connection.getGenesisHash())) {
    throw new Error("V2 E2E refuses public-chain genesis");
  }

  // ---- keys and funds ----------------------------------------------------
  // Disposable localnet only: no funded external keys or live price accounts.
  const payer = Keypair.generate();
  const solverKp = Keypair.generate();
  const wallet = Keypair.fromSeed(label("e2e wallet seed"));
  for (const k of [payer, solverKp, wallet]) {
    const status = await connection.confirmTransaction(
      await connection.requestAirdrop(k.publicKey, 50_000_000_000), "confirmed",
    );
    if (status.value.err) throw new Error(`airdrop failed: ${JSON.stringify(status.value.err)}`);
  }
  ok("airdrops");

  const send = async (ixs: TransactionInstruction[], signers: Keypair[]) => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = payer.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
    const sig = await connection.sendRawTransaction(tx.serialize());
    const status = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (status.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(status.value.err)}`);
    return sig;
  };

  // ---- trees ---------------------------------------------------------------
  const treeExists = await connection.getAccountInfo(
    PublicKey.findProgramAddressSync([Buffer.from("tree")], REGISTRY)[0],
  );
  if (!treeExists) {
    await send([initializeIx("registry", payer.publicKey), initializeIx("census", payer.publicKey)], []);
  }
  ok("trees initialized");

  // ---- mints ---------------------------------------------------------------
  const fork = process.env.JUPITER_FIXTURE_DIR ? loadJupiterFixture(process.env.JUPITER_FIXTURE_DIR) : undefined;
  const speculative = Boolean(fork && process.env.SPECULATIVE_TRADING === "1");
  const usdcMint = Keypair.fromSeed(label("e2e usdc mint seed"));
  const solMint = Keypair.fromSeed(label("e2e sol mint seed"));
  const inputMint = fork ? new PublicKey(fork.approval.token0) : usdcMint.publicKey;
  const outputMint = fork ? new PublicKey(fork.approval.token1) : solMint.publicKey;
  const inputDecimals = fork?.inputDecimals ?? 6, outputDecimals = fork?.outputDecimals ?? 9;
  const forkPlanner = fork ? await JupiterForkPlanner.create(connection, fork) : undefined;
  if (fork) {
    await send([
      createAtaIdempotentIx(payer.publicKey, wallet.publicKey, inputMint),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ataAddress(wallet.publicKey, inputMint), lamports: 150_000_000 }),
      syncNative(ataAddress(wallet.publicKey, inputMint)),
    ], []);
  } else {
    const rent = await connection.getMinimumBalanceForRentExemption(82);
    for (const [mint, decimals] of [
      [usdcMint, 6],
      [solMint, 9],
    ] as const) {
      if (await connection.getAccountInfo(mint.publicKey)) continue;
      await send(
        [
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: mint.publicKey,
            lamports: rent,
            space: 82,
            programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          }),
          initializeMint2Ix(mint.publicKey, decimals, payer.publicKey),
        ],
        [mint],
      );
    }
    // Wallet holds 150 USDC; the solver holds 1.0 SOL-token of inventory.
    await send(
      [
        createAtaIdempotentIx(payer.publicKey, wallet.publicKey, inputMint),
        mintToIx(inputMint, ataAddress(wallet.publicKey, inputMint), payer.publicKey, 150_000_000n),
        createAtaIdempotentIx(payer.publicKey, solverKp.publicKey, outputMint),
        mintToIx(outputMint, ataAddress(solverKp.publicKey, outputMint), payer.publicKey, 1_000_000_000n),
      ],
      [],
    );
  }
  ok("mints and balances");

  // ---- services (in-process, real HTTP) -----------------------------------
  const store = new IndexerStore();
  const poller = new Poller(connection, store);
  const indexerUrl = await listen(buildIndexer(store), 8787);
  const relayerUrl = await listen(
    buildRelayer({ connection, payer, minWalletLamports: 1n }), 8788,
  );
  // Synthetic Pyth accounts loaded by this disposable validator's genesis.
  const priceAccounts: Record<string, string> = {
    [inputMint.toBase58()]: priceAccountFor("e2e usdc price acct").toBase58(),
    [outputMint.toBase58()]: priceAccountFor("e2e sol price acct").toBase58(),
  };
  if (speculative) delete priceAccounts[outputMint.toBase58()];
  const usdcFeedId = label("usdc pyth feed");
  const solFeedId = label("sol pyth feed");
  solverFixture = await startSolverFixture(connection, solverKp, priceAccounts, keepRunning ? demoPortBase + 2 : 0,
    { planner: forkPlanner, lookupAddresses: forkPlanner?.lookupAddresses, allowUnpriced: speculative });
  let solverUrl = solverFixture.url;
  const actionsUrl = await listen(buildActions({ connection, baseUrl: keepRunning ? `http://127.0.0.1:${demoPortBase + 3}` : "http://e2e.local" }), 8790);
  ok(`services up (indexer ${indexerUrl})`);

  // ---- the SDK client ------------------------------------------------------
  const prover: Prover = {
    async prove(circuit, input) {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input,
        join(ROOT, `circuits/build/${circuit}_js/${circuit}.wasm`),
        join(ROOT, `circuits/build/${circuit}_dev.zkey`),
      );
      return { proof: proof as object, publicSignals: publicSignals as string[] };
    },
  };
  const origin = "https://demo.ghostlink.dev";
  const gl = await GhostLink.init({
    cluster: "localnet",
    indexer: indexerUrl,
    relayer: relayerUrl,
    solver: solverUrl,
    actions: actionsUrl,
    prover,
    origin,
  });

  // ---- registration (true secret derivation) ------------------------------
  const signMessage = async (msg: Uint8Array) =>
    ed25519.sign(msg, wallet.secretKey.subarray(0, 32));
  const identity = await deriveIdentity(signMessage, {
    cluster: "devnet",
    domain: new URL(origin).host,
    address: wallet.publicKey.toBase58(),
  });
  if (!identity.deterministic) throw new Error("expected deterministic signer");
  const reg = await buildRegistration(
    identity,
    wallet.publicKey.toBytes(),
    REGISTRY.toBytes(),
    "devnet",
    signMessage,
  );
  const regRes = await fetch(`${relayerUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      walletPubkey: wallet.publicKey.toBase58(),
      messageHex: bytesToHex(reg.message),
      signatureHex: bytesToHex(reg.signature),
      commitmentHex: bytesToHex(fieldToBytes32(identity.commitment)),
    }),
  });
  if (!regRes.ok) throw new Error(`register: ${await regRes.text()}`);
  ok("registered through the relayer");

  // ---- census snapshot -----------------------------------------------------
  const holding = ataAddress(wallet.publicKey, inputMint);
  const snapRes = await fetch(`${relayerUrl}/snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), holding: holding.toBase58() }),
  });
  if (!snapRes.ok) throw new Error(`snapshot: ${await snapRes.text()}`);
  await poller.tick();
  ok(`indexer ingested ${store.registryLeaves.length} registry + ${store.censusLeaves.length} census leaves`);

  // ---- prove login (SDK + indexer witness) ---------------------------------
  const binding = (await (await fetch(`${indexerUrl}/registry/binding/${wallet.publicKey.toBase58()}`)).json()) as {
    leafIndex: number;
  };
  const census = await gl.latestCensus(wallet.publicKey.toBytes(), inputMint.toBytes());
  const regLeaf = BigInt(store.registryLeaves[binding.leafIndex]!);
  const cenLeaf = BigInt(store.censusLeaves[census.leafIndex]!);
  const regPath = await gl.verifiedPath("registry", binding.leafIndex, regLeaf);
  const cenPath = await gl.verifiedPath("census", census.leafIndex, cenLeaf);

  const currentSlot = BigInt(await connection.getSlot("confirmed"));
  const expirySlot = currentSlot + 50_000n;
  const minSlot = BigInt(census.slot);
  const home = wallet.publicKey; // default home: the registering wallet

  const claim = {
    kind: "holdsAtLeast" as const,
    mint: inputMint.toBytes(),
    amount: 100_000_000n,
    maxAgeSlots: 9_000n,
  };
  const policy: Policy = {
    dailyCapUsdE6: 200_000_000n,
    maxSlippageBps: 100,
    bigActionThresholdUsdE6: 50_000_000n,
    noOracleCapUsdE6: 20_000_000n,
    sessionMaxSlots: 216_000n,
    allowedOutMints: [],
    oracleFeeds: [
      { mint: inputMint.toBytes(), feedId: usdcFeedId, decimals: inputDecimals },
      { mint: outputMint.toBytes(), feedId: solFeedId, decimals: outputDecimals },
    ],
  };
  if (speculative) {
    policy.oracleFeeds = policy.oracleFeeds.slice(0, 1);
    policy.speculative = { dailyBuyCapUsdE6: 30_000_000n, maxCostExposureUsdE6: 20_000_000n,
      maxPositions: 2, baseMints: [inputMint.toBytes()] };
  }
  botFixture = await startBotFixture(connection, origin, policy);
  const request = { requestKey: "ab".repeat(16), appId: deriveAppId(identity.sField, deriveDomainHash(origin)).toString(),
    home: home.toBase58(), sessionExpirySlot: expirySlot.toString() };
  let { consent } = await botFixture.create(request);
  const session = sessionPublicKey(0, hexToBytes(consent.sessionKeyHex));
  ok("authenticated bot request created; owner received only the public session key");
  const loginInputFor = (signer: typeof session, expires: bigint) => buildLoginInput({
    identity,
    origin,
    claim,
    minSlot,
    session: signer,
    expirySlot: expires,
    home: home.toBytes(),
    policy,
    witness: {
      registry: {
        walletPubkey: wallet.publicKey.toBytes(),
        index: regPath.index,
        siblings: regPath.siblings,
        root: regPath.root,
      },
      census: {
        index: cenPath.index,
        siblings: cenPath.siblings,
        root: cenPath.root,
        amount: BigInt(census.amount),
        slot: BigInt(census.slot),
      },
    },
  });
  const { input, appId, domainHash } = loginInputFor(session, expirySlot);
  const rawLogin = await prover.prove("login", input);
  const loginProof = {
    appId,
    proof: proofToBytes(rawLogin.proof as SnarkjsProof),
    snarkjsProof: rawLogin.proof as object,
    publicSignals: rawLogin.publicSignals,
    publicInputBytes: publicSignalsToBytes(rawLogin.publicSignals),
  };
  ok("login proof made on this machine");

  // ---- server-side verification -------------------------------------------
  const vk = JSON.parse(readFileSync(join(ROOT, "circuits/keys/login_vk.json"), "utf8"));
  const verdict = await verifyLogin({
    proof: rawLogin.proof as object,
    publicSignals: rawLogin.publicSignals,
    expectedDomain: origin,
    verificationKey: vk,
    indexer: indexerUrl,
    expect: { pocket: { policy, sessionKind: session.kind }, session: { key32: session.key32, expirySlot, currentSlot }, home: home.toBytes() },
  });
  if (!verdict.ok) throw new Error(`verifyLogin failed: ${verdict.reason}`);
  ok(`server-side verifyLogin ok, appId ${verdict.appId!.slice(0, 12)}…`);

  // ---- open the pocket session ---------------------------------------------
  const glSession = {
    appId,
    appIdBase58: bs58.encode(fieldToBytes32(appId)),
    proof: loginProof,
    signer: session,
    expirySlot,
  };
  const pocketHandle = gl.pocketFor(glSession, home.toBytes(), policy);
  await gl.openSession(
    glSession,
    pocketHandle,
    { mint: inputMint.toBytes(), threshold: claim.amount, minSlot, claim: true },
    { registry: regPath.root, census: cenPath.root },
    domainHash,
  );
  const pocket = pocketPda(fieldToBytes32(appId));
  ok(`pocket open at ${pocket.toBase58()}`);
  if ((await botFixture.confirm(consent.id)).state !== "confirmed") throw new Error("bot consent not confirmed");
  await botFixture.restart();
  const recovered = await botFixture.create(request);
  if (recovered.consent.sessionKeyHex !== consent.sessionKeyHex || recovered.state !== "confirmed") throw new Error("bot restart changed consent");
  await botFixture.confirm(consent.id);
  ok("bot permissions confirmed on-chain and encrypted session restored after server restart");

  const ownerBody = async (action: "sweep" | "revoke") => {
    const account = await connection.getAccountInfo(pocket, "confirmed");
    if (!account) throw new Error("pocket missing before owner action");
    const nonce = readPocketAccount(account).ownerActionNonce;
    const digest = action === "sweep" ? sweepDigest(pocket.toBytes(), nonce) : revokeDigest(pocket.toBytes(), nonce);
    const ownerInput = { registry_root: regPath.root.toString(), domain_hash: input.domain_hash, app_id: input.app_id,
      action_hash: hashToField(digest).toString(), s: input.s, pk_hi: input.pk_hi, pk_lo: input.pk_lo, reg_index: input.reg_index, reg_siblings: input.reg_siblings };
    const proof = await prover.prove("owner", ownerInput as Record<string, string | string[]>);
    const bytes = proofToBytes(proof.proof as SnarkjsProof);
    return { pocket: pocket.toBase58(), action, proofAHex: bytesToHex(bytes.a), proofBHex: bytesToHex(bytes.b), proofCHex: bytesToHex(bytes.c),
      registryRootHex: bytesToHex(fieldToBytes32(regPath.root)) };
  };

  // ---- fund through the Blink ----------------------------------------------
  const appIdHex = bytesToHex(fieldToBytes32(appId));
  const fundRes = await fetch(
    `${actionsUrl}/actions/fund/${appIdHex}?mint=${inputMint.toBase58()}&rawAmount=25000000`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: wallet.publicKey.toBase58() }),
    },
  );
  if (!fundRes.ok) throw new Error(`fund: ${await fundRes.text()}`);
  const fundTx = Transaction.from(
    Buffer.from(((await fundRes.json()) as { transaction: string }).transaction, "base64"),
  );
  fundTx.partialSign(wallet);
  const fundSig = await connection.sendRawTransaction(fundTx.serialize());
  const fundStatus = await connection.confirmTransaction(fundSig, "confirmed");
  if (fundStatus.value.err) throw new Error(`funding failed: ${JSON.stringify(fundStatus.value.err)}`);
  ok("pocket funded through the Blink (wallet-signed deposit)");

  // ---- fill an intent through the solver ------------------------------------
  if (forkPlanner) {
    await exerciseJupiterPocket({ connection, pocket, input: inputMint, output: outputMint, payer, wallet, solverKey: solverKp,
      bot: botFixture, solver: solverFixture, consent, planner: forkPlanner, send, revoke: async () => {
        const response = await fetch(`${relayerUrl}/owner-action`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(await ownerBody("revoke")) });
        if (!response.ok) throw new Error(`revoke failed: ${await response.text()}`);
      } });
  } else {
    // The pocket's output token account is the app's (or funder's) job,
    // not the solver's: solver-paid rent would flow to the user's home
    // on sweep and could be farmed.
    await send([createAtaIdempotentIx(payer.publicKey, pocket, outputMint)], []);
    if (process.env.RESTORE_DRILL === "1") {
      // The fixtures have no concurrent producers here. Snapshots deliberately predate a released signature.
      await botFixture.backup(); await solverFixture.backup();
      const oldConsent = consent;
      const params = { inMint: inputMint.toBytes(), inMax: 25_000_000n, outMint: outputMint.toBytes(),
        outMin: BigInt(process.env.OUT_MIN ?? "160000000"), deadlineSlot: BigInt(await connection.getSlot("confirmed")) + 1500n };
      const lostOrder = await botFixture.prepare(oldConsent, params);
      await botFixture.restore(); solverUrl = await solverFixture.restore();
      let refused = false;
      try { await botFixture.prepare(oldConsent, params); } catch { refused = true; }
      if (!refused) throw new Error("restored bot reused its old signing key");
      const submitOld = () => fetch(`${solverUrl}/intent`, { method: "POST", headers: { "content-type": "application/json" }, body: lostOrder.body });
      if ((await submitOld()).ok) throw new Error("unconfigured restored solver accepted a trade");
      solverFixture.assertNoTransactions();
      const nextExpiry = expirySlot + 1000n;
      const next = await botFixture.create({ ...request, requestKey: "dc".repeat(16), sessionExpirySlot: nextExpiry.toString() });
      if (next.consent.sessionKeyHex === oldConsent.sessionKeyHex) throw new Error("recovery reused a session key");
      await solverFixture.prepareRecovery(pocket.toBase58(), { sessionKind: 0, sessionKeyHex: next.consent.sessionKeyHex + "00" });
      if ((await submitOld()).ok) throw new Error("restored solver traded before owner rotation");
      solverFixture.assertNoTransactions();
      const nextSigner = sessionPublicKey(0, hexToBytes(next.consent.sessionKeyHex));
      const nextRaw = await prover.prove("login", loginInputFor(nextSigner, nextExpiry).input);
      const nextSession = { ...glSession, signer: nextSigner, expirySlot: nextExpiry,
        proof: { ...loginProof, proof: proofToBytes(nextRaw.proof as SnarkjsProof), snarkjsProof: nextRaw.proof as object,
          publicSignals: nextRaw.publicSignals, publicInputBytes: publicSignalsToBytes(nextRaw.publicSignals) } };
      await gl.openSession(nextSession, gl.pocketFor(nextSession, home.toBytes(), policy),
        { mint: inputMint.toBytes(), threshold: claim.amount, minSlot, claim: true }, { registry: regPath.root, census: cenPath.root }, domainHash);
      const until = Date.now() + 60_000;
      for (;;) {
        try { if (!(await solverFixture.prepareRecovery(pocket.toBase58())).rotationRequired) break; }
        catch (error) { if (Date.now() >= until) throw error; }
        if (Date.now() >= until) throw new Error("owner recovery rotation did not finalize");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await botFixture.confirm(next.consent.id); consent = next.consent;
      if ((await submitOld()).ok) throw new Error("pre-backup authority still accepted after recovery");
      solverFixture.assertNoTransactions();
      ok("encrypted bot and solver backups restored; old signature refused before and after finalized owner rotation");
    }
    const deadline = BigInt(await connection.getSlot("confirmed")) + 500n;
    const tx = await botFixture.fill(consent, solverUrl, {
      inMint: inputMint.toBytes(),
      inMax: 25_000_000n,
      outMint: outputMint.toBytes(),
      outMin: BigInt(process.env.OUT_MIN ?? "160000000"),
      deadlineSlot: deadline,
    }, () => solverFixture!.restart());
    solverFixture.assertSingleTransaction();
    ok(`durably allocated bot intent filled after bot restart, lost acknowledgment and solver restart: ${tx.signature.slice(0, 16)}…`);

    const expectedOut = process.env.OUT_MIN ?? "160000000";
    const outBalance = await connection.getTokenAccountBalance(ataAddress(pocket, outputMint));
    if (outBalance.value.amount !== expectedOut) {
      throw new Error(`pocket out balance ${outBalance.value.amount}, expected ${expectedOut}`);
    }
    ok(`pocket received ${Number(expectedOut) / 1e9} SOL-token atomically`);
  }

  // ---- sweep home with an owner proof ----------------------------------------
  const sweepMints = fork ? [inputMint, outputMint] : [outputMint];
  const expectedHome = new Map<string, bigint>();
  await send(sweepMints.map(mint => createAtaIdempotentIx(payer.publicKey, wallet.publicKey, mint)), []);
  for (const mint of sweepMints) {
    const held = BigInt((await connection.getTokenAccountBalance(ataAddress(pocket, mint))).value.amount);
    const homeHeld = BigInt((await connection.getTokenAccountBalance(ataAddress(wallet.publicKey, mint))).value.amount);
    expectedHome.set(mint.toBase58(), held + homeHeld);
  }
  const sweepRes = await fetch(`${relayerUrl}/owner-action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...await ownerBody("sweep"),
      home: wallet.publicKey.toBase58(),
      tokenPairs: sweepMints.map(mint => ({ source: ataAddress(pocket, mint).toBase58(),
        destination: ataAddress(wallet.publicKey, mint).toBase58(), mint: mint.toBase58() })),
    }),
  });
  if (!sweepRes.ok) throw new Error(`sweep: ${await sweepRes.text()}`);
  for (const mint of sweepMints) {
    const homeBalance = await connection.getTokenAccountBalance(ataAddress(wallet.publicKey, mint));
    if (BigInt(homeBalance.value.amount) !== expectedHome.get(mint.toBase58()) || await connection.getAccountInfo(ataAddress(pocket, mint))) {
      throw new Error("owner sweep did not return the complete balance and close the pocket token account");
    }
  }
  ok(`owner proof recovered ${sweepMints.length} complete token balances and closed their pocket accounts`);
  const recoveredPocket = await connection.getAccountInfo(pocket, "confirmed");
  if (!recoveredPocket || readPocketAccount(recoveredPocket).speculativePositions.length !== 0) {
    throw new Error("owner recovery retained speculative trading permission");
  }

  console.log(
    "\nE2E PASSED — register, snapshot, bot consent, prove, verify, open, confirm, restart, fund, bot-signed fill, sweep.",
  );
  if (keepRunning) {
    console.log(`Local demo stack running: indexer ${indexerUrl}, relayer ${relayerUrl}, solver ${solverUrl}, actions ${actionsUrl}. Stop with Ctrl+C.`);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await poller.tick().catch((error) => console.error("indexer poll:", error));
    }
  }
}

main().then(async () => {
  await botFixture?.close();
  await solverFixture?.close();
  process.exit(0);
}).catch(async (e) => {
  console.error("E2E FAILED:", e);
  await botFixture?.close().catch(() => {});
  await solverFixture?.close().catch(() => {});
  process.exit(1);
});
