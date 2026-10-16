/** Full Pocket settlement against cloned binaries. Never used outside the guarded localnet harness. */
import { PublicKey, SystemProgram, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { ataAddress, createAtaIdempotentIx, fillStatePda, isPocketNonceUsed, readPocketAccount } from "@ghostlink/service-kit";
import type { BotConsent, BotIntentParams } from "@ghostlink/bot";
import type { IntentSubmission } from "@ghostlink/common";
import type { startBotFixture } from "./bot-session.js";
import type { startSolverFixture } from "./solver-session.js";
import { JupiterForkPlanner, syncNative } from "./jupiter-fixture.js";

export async function exerciseJupiterPocket(x: {
  connection: Connection; pocket: PublicKey; input: PublicKey; output: PublicKey; solverKey: Keypair; payer: Keypair; wallet: Keypair;
  bot: Awaited<ReturnType<typeof startBotFixture>>; solver: Awaited<ReturnType<typeof startSolverFixture>>; consent: BotConsent;
  planner: JupiterForkPlanner; send: (ixs: TransactionInstruction[], signers: Keypair[]) => Promise<string>;
  revoke: () => Promise<void>;
}) {
  const { connection: c, pocket, input, output, bot, solver, planner, wallet, payer, solverKey, send } = x;
  const balance = async (owner: PublicKey, mint: PublicKey) => BigInt((await c.getTokenAccountBalance(ataAddress(owner, mint))).value.amount);
  const state = async () => { const a = await c.getAccountInfo(pocket, "confirmed"); if (!a) throw new Error("pocket missing"); return a; };
  const params = async (inMint: PublicKey, outMint: PublicKey, inMax: bigint): Promise<BotIntentParams> => ({
    inMint: inMint.toBytes(), outMint: outMint.toBytes(), inMax, outMin: (await planner.quote(inMint, inMax)) * 9950n / 10000n,
    deadlineSlot: BigInt(await c.getSlot("confirmed")) + 500n,
  });
  await send([createAtaIdempotentIx(payer.publicKey, pocket, output)], []);
  const buy = await params(input, output, 20_000_000n);
  const beforeIn = await balance(pocket, input), beforeOut = await balance(pocket, output);
  const bought = await bot.fill(x.consent, solver.url, buy, () => solver.restart());
  solver.assertSingleTransaction();
  const received = await balance(pocket, output) - beforeOut;
  if (beforeIn - await balance(pocket, input) !== buy.inMax || received < buy.outMin ||
      !isPocketNonceUsed(readPocketAccount(await state()), bought.nonce)) throw new Error("atomic buy settlement differs from intent");
  console.log("✓ Pocket buy through real Jupiter/Raydium programs, lost acknowledgment, durable retry and exact nonce consumption");

  const sell = await params(output, input, received / 2n);
  const sellIn = await balance(pocket, output), sellOut = await balance(pocket, input);
  const sold = await bot.fill(x.consent, solver.url, sell, () => solver.restart());
  solver.assertSingleTransaction(2);
  if (sellIn - await balance(pocket, output) !== sell.inMax || await balance(pocket, input) - sellOut < sell.outMin ||
      !isPocketNonceUsed(readPocketAccount(await state()), sold.nonce)) throw new Error("atomic sell settlement differs from intent");
  console.log("✓ Pocket sell returned wrapped SOL; a different durable nonce settled exactly once");

  const failure = await bot.prepare(x.consent, await params(input, output, 1_000_000n));
  const revokeParams = await params(input, output, 1_000_000n);
  const pendingRevoke = await bot.prepare(x.consent, revokeParams);
  const beforePocket = await state();
  const balances = () => Promise.all([balance(pocket, input), balance(pocket, output), balance(solverKey.publicKey, input), balance(solverKey.publicKey, output)]);
  const beforeBalances = await balances();
  solver.beforeNextBroadcast(async () => {
    // Another local wallet moves the pool after both successful simulations. The test transport
    // alone skips preflight for this packet, so rollback is proved by an actual failed transaction.
    await send([createAtaIdempotentIx(payer.publicKey, wallet.publicKey, output),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ataAddress(wallet.publicKey, input), lamports: 2_000_000_000 }),
      syncNative(ataAddress(wallet.publicKey, input))], []);
    await send([planner.instruction(wallet.publicKey, input, ataAddress(wallet.publicKey, output), 2_000_000_000n, 1n, 0)], [wallet]);
  });
  const submit = (body: string) => fetch(`${solver.url}/intent`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const response = await submit(failure.body);
  if (!response.ok) throw new Error(`failure fixture refused before submission: ${response.status} ${await response.text()}`);
  let outcome = await response.json() as IntentSubmission;
  const until = Date.now() + 20_000;
  while (outcome.state !== "failed" && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const result = await fetch(`${solver.url}/intents/${outcome.intentHashHex}`);
    if (!result.ok) throw new Error(`failure status: ${result.status}`);
    outcome = await result.json() as IntentSubmission;
  }
  if (outcome.state !== "failed" || !outcome.signature) throw new Error("expected an on-chain failed transaction");
  const transaction = await c.getTransaction(outcome.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const logs = transaction?.meta?.logMessages ?? [];
  if (!transaction?.meta?.err || !logs.some(s => s.includes("Instruction: FillBegin")) || !logs.some(s => s.includes("Instruction: SwapBaseInput"))) {
    throw new Error("failure did not execute Pocket input transfer and the real DEX route");
  }
  const after = await state(), afterBalances = await balances();
  if (!after.data.equals(beforePocket.data) || afterBalances.some((amount, i) => amount !== beforeBalances[i]) ||
      isPocketNonceUsed(readPocketAccount(after), failure.signed.intent.nonce) || await c.getAccountInfo(fillStatePda(pocket, failure.signed.intent.nonce))) {
    throw new Error("failed DEX transaction retained token, nonce, budget or temporary account changes");
  }
  await solver.restart();
  const retry = await submit(failure.body), retryState = await retry.json() as IntentSubmission;
  if (!retry.ok || retryState.state !== "failed" || retryState.signature !== outcome.signature) throw new Error("failed trade retry changed identity");
  solver.assertSingleTransaction(3);
  console.log("✓ Real market-move failure rolled back Pocket/solver tokens, nonce, spend budget and fill account; restart preserved failed identity");

  await x.revoke();
  const revoked = await submit(pendingRevoke.body);
  if (revoked.status !== 403) throw new Error(`revoked saved intent accepted: ${revoked.status}`);
  let botRefused = false;
  try { await bot.prepare(x.consent, revokeParams); } catch (error) {
    if (!(error instanceof Error) || error.message !== "confirmed pocket does not match the approved bot permissions") throw error;
    botRefused = true;
  }
  if (!botRefused) throw new Error("bot signed after on-chain revocation");
  solver.assertSingleTransaction(3);
  console.log("✓ Owner revocation refused both a previously signed intent and further bot signing without planning another route");
}
