/**
 * The relayer / paymaster (build plan section 7).
 *
 * In plain language: users never pay fees or even hold SOL to use
 * GhostLink; this service wraps their signed messages and proofs in
 * transactions and pays. It can't forge anything — the programs demand
 * the user's own signature or proof inside every instruction — so the
 * worst a hacked relayer can do is stop working. Spam control: per-IP
 * and per-wallet rate limits, a rolling daily spend budget, and an
 * optional allowlist of origins whose pockets it will create.
 *
 * The instruction allowlist is this file: register, snapshot,
 * open_session, sweep_home (plus the home's missing token accounts),
 * propose/cancel change, revoke_session. Nothing else is ever built or
 * signed.
 */
import type { Server } from "node:http";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  hexToBytes,
  type OpenSessionRequest,
  type OwnerActionRequest,
  type RegisterRequest,
  type SnapshotRequest,
} from "@ghostlink/common";
import {
  HttpError,
  type Handler,
  RateLimiter,
  Router,
  Semaphore,
  POCKET_ACCOUNT_SIZE,
  badRequest,
  cancelChangeIx,
  clientIp,
  computeBudget,
  ed25519Ix,
  isPocketAccount,
  openSessionIx,
  pocketPda,
  proposeChangeIx,
  registerIx,
  revokeSessionIx,
  snapshotIx,
  sweepHomeIx,
} from "@ghostlink/service-kit";
import { policyFromDtoBytes } from "./policy.js";
import { prepareRecoverySweep } from "./recovery.js";
import { RelayerJournal } from "./journal.js";
import { RelayerSubmission, requestIdentity } from "./submission.js";

export interface RelayerDeps {
  journal: RelayerJournal;
  connection: Connection;
  payer: Keypair;
  /** Lamports a wallet must hold before we pay for its registration. */
  minWalletLamports?: bigint;
  /** Lowercase hex domain hashes whose pockets this relayer creates; unset = any. */
  allowedDomainHashes?: Set<string>;
  /** Honour X-Forwarded-For (only behind a proxy you control). */
  trustProxy?: boolean;
  /** Transactions in flight at once; default 8. */
  maxInFlight?: number;
}

const MAX_TOKEN_PAIRS = 16;

export function buildServer(deps: RelayerDeps): Server & { drain(): void; readonly active: number } {
  const { connection, payer } = deps;
  if (!deps.journal || deps.journal.scope.payer !== payer.publicKey.toBase58()) throw new Error("relayer requires a journal bound to its payer");
  const submissions = new RelayerSubmission(connection, deps.journal);
  let draining = false, active = 0;
  const minLamports = deps.minWalletLamports ?? 10_000_000n; // 0.01 SOL
  const ipLimiter = new RateLimiter(30, 60_000);
  const walletLimiter = new RateLimiter(3, 60_000);
  const snapshotLimiter = new RateLimiter(1, 60_000);
  const inFlight = new Semaphore(deps.maxInFlight ?? 8);
  const router = new Router();

  function throttle(raw: Parameters<typeof clientIp>[0]): void {
    if (!ipLimiter.allow(clientIp(raw, deps.trustProxy))) throw new HttpError(429, "rate limited");
  }

  async function rentFor(size: number): Promise<bigint> {
    const rent = await connection.getMinimumBalanceForRentExemption(size, "confirmed");
    if (!Number.isSafeInteger(rent) || rent <= 0) throw new HttpError(503, "account rent unavailable; try again later");
    return BigInt(rent);
  }

  interface Preparation { instructions: TransactionInstruction[]; rent: bigint; signers?: Keypair[];
    tokenPairs?: { source: string; destination: string; mint: string }[] }
  function paid(path: string, prepare: (request: Parameters<Handler>[0]) => Promise<Preparation>): void {
    router.post(path, async request => {
      throttle(request.raw);
      if (draining) throw new HttpError(503, "relayer is draining");
      active++;
      try {
        const body = objectBody(request.body);
        let identity: ReturnType<typeof requestIdentity>;
        try { identity = requestIdentity(path, body); } catch { throw badRequest("valid requestIdHex required; snapshot retries must reuse their original ID"); }
        const prior = deps.journal.get(identity.id);
        if (prior && prior.digest !== identity.digest) throw new HttpError(409, "request ID is bound to different content");
        const receipt = await inFlight.run(async () => {
          if (draining) throw new HttpError(503, "relayer is draining");
          return submissions.submit(identity.id, identity.digest, async () => {
            const plan = await prepare(request);
            const latest = await connection.getLatestBlockhashAndContext({ commitment: "confirmed" });
            if (!Number.isSafeInteger(latest.context.slot) || latest.context.slot < 0) throw new HttpError(503, "transaction context unavailable");
            const tx = new Transaction({ feePayer: payer.publicKey, ...latest.value }).add(...plan.instructions);
            tx.sign(payer, ...(plan.signers ?? []));
            const bytes = tx.serialize(), fee = await connection.getFeeForMessage(tx.compileMessage(), "confirmed");
            if (!Number.isSafeInteger(fee.context.slot) || fee.context.slot < latest.context.slot ||
              !Number.isSafeInteger(fee.value) || fee.value === null || fee.value < 0 || fee.value > 20_000) throw new HttpError(503, "transaction fee unavailable or excessive");
            return { rawBase64: bytes.toString("base64"), signature: bs58.encode(tx.signature!), blockhash: latest.value.blockhash,
              lastValidBlockHeight: latest.value.lastValidBlockHeight, minContextSlot: latest.context.slot,
              feeLamports: fee.value.toString(), rentLamports: plan.rent.toString(), tokenPairs: plan.tokenPairs };
          });
        });
        return { status: receipt.state === "failed" ? 502 : ["confirmed", "finalized"].includes(receipt.state) ? 200 : 202, json: receipt };
      } finally { active--; }
    });
  }
  router.get("/submissions/:requestIdHex", async ({ params, raw }) => {
    throttle(raw);
    if (draining) throw new HttpError(503, "relayer is draining");
    const id = params.requestIdHex!;
    if (!submissions || !/^[0-9a-f]{64}$/.test(id) || !deps.journal.get(id)) throw new HttpError(404, "submission not found");
    active++;
    try { return { json: await inFlight.run(() => submissions.status(id)) }; }
    finally { active--; }
  });
  router.get("/health", async () => ({
    json: {
      ok: true,
      payer: payer.publicKey.toBase58(),
      spentLamports24h: deps.journal.spent().toString(),
      dailyBudgetLamports: deps.journal.dailyBudget.toString(),
      restrictedToPartners: Boolean(deps.allowedDomainHashes),
    },
  }));

  paid("/register", async ({ body, raw }) => {
    const req = objectBody(body) as Partial<RegisterRequest>;
    const wallet = pubkey(req.walletPubkey, "walletPubkey");
    if (!walletLimiter.allow(wallet.toBase58())) throw new HttpError(429, "rate limited");
    const signature = hex(req.signatureHex, 64, "signatureHex");
    const message = hex(req.messageHex, undefined, "messageHex");
    const commitment = hex(req.commitmentHex, 32, "commitmentHex");
    const balance = await connection.getBalance(wallet);
    if (BigInt(balance) < minLamports) throw badRequest("wallet below the minimum balance");
    const pre = ed25519Ix(wallet.toBytes(), signature, message);
    const reg = registerIx(payer.publicKey, wallet, commitment);
    // Registry Binding: discriminator + leaf index + commitment + slot.
    return { instructions: [pre, reg], rent: await rentFor(8 + 8 + 32 + 8) };
  });

  paid("/snapshot", async ({ body, raw }) => {
    const req = objectBody(body) as Partial<SnapshotRequest>;
    const wallet = pubkey(req.wallet, "wallet");
    const holding = pubkey(req.holding, "holding");
    // One snapshot per (wallet, holding) per minute: a burst of
    // snapshots would also churn the census root ring under live proofs.
    if (!snapshotLimiter.allow(`${wallet.toBase58()}:${holding.toBase58()}`)) {
      throw new HttpError(429, "that holding was snapshotted less than a minute ago");
    }
    const ix = snapshotIx(payer.publicKey, wallet, holding);
    return { instructions: [ix], rent: 0n };
  });

  paid("/open-session", async ({ body, raw }) => {
    const req = objectBody(body) as Partial<OpenSessionRequest>;
    const appId = hex(req.appIdHex, 32, "appIdHex");
    const domainHash = hex(req.domainHashHex, 32, "domainHashHex");
    if (req.sessionKind !== 0 && req.sessionKind !== 1) throw badRequest("sessionKind must be 0 or 1");
    const pocket = pocketPda(appId);
    const exists = isPocketAccount(await connection.getAccountInfo(pocket, "confirmed"), appId);
    if (!exists && deps.allowedDomainHashes && !deps.allowedDomainHashes.has(Buffer.from(domainHash).toString("hex"))) {
      throw new HttpError(403, "this relayer only creates pockets for its partner apps");
    }
    if (!exists && !req.policy) throw badRequest("policy required to create a pocket");
    if (typeof req.claimHoldings !== "boolean") throw badRequest("claimHoldings must be a boolean");
    const ix = openSessionIx(payer.publicKey, {
      proofA: hex(req.proofAHex, 64, "proofAHex"),
      proofB: hex(req.proofBHex, 128, "proofBHex"),
      proofC: hex(req.proofCHex, 64, "proofCHex"),
      registryRoot: hex(req.registryRootHex, 32, "registryRootHex"),
      censusRoot: hex(req.censusRootHex, 32, "censusRootHex"),
      domainHash,
      appId,
      mint: pubkey(req.mint, "mint"),
      threshold: u64(req.threshold, "threshold"),
      minSlot: u64(req.minSlot, "minSlot"),
      claimHoldings: req.claimHoldings,
      sessionKind: req.sessionKind,
      sessionKey: hex(req.sessionKeyHex, 33, "sessionKeyHex"),
      sessionExpirySlot: u64(req.sessionExpirySlot, "sessionExpirySlot"),
      home: pubkey(req.home, "home"),
      policy: req.policy ? policyFromDtoBytes(req.policy) : undefined,
    });
    return { instructions: [computeBudget(400_000), ix], rent: exists ? 0n : await rentFor(POCKET_ACCOUNT_SIZE) };
  });

  paid("/owner-action", async ({ body, raw }) => {
    const req = objectBody(body) as Partial<OwnerActionRequest>;
    const pocket = pubkey(req.pocket, "pocket");
    const proof = {
      proofA: hex(req.proofAHex, 64, "proofAHex"),
      proofB: hex(req.proofBHex, 128, "proofBHex"),
      proofC: hex(req.proofCHex, 64, "proofCHex"),
      registryRoot: hex(req.registryRootHex, 32, "registryRootHex"),
    };
    const instructions: TransactionInstruction[] = [computeBudget(400_000)];
    let cost = 0n;
    let extraSigners: Keypair[] = [];
    let tokenPairs: {source:string;destination:string;mint:string}[] | undefined;
    switch (req.action) {
      case "sweep": {
        const home = pubkey(req.home, "home");
        const pairs = req.tokenPairs ?? [];
        if (!Array.isArray(pairs) || pairs.length > MAX_TOKEN_PAIRS) {
          throw badRequest(`at most ${MAX_TOKEN_PAIRS} token pairs per sweep`);
        }
        const parsed = pairs.map((pair) => {
          const p = objectBody(pair);
          return {
            source: pubkey(p.source, "tokenPairs.source"),
            destination: p.destination === undefined ? undefined : pubkey(p.destination, "tokenPairs.destination"),
            mint: p.mint === undefined ? undefined : pubkey(p.mint, "tokenPairs.mint"),
          };
        });
        const prepared = await prepareRecoverySweep(connection,payer.publicKey,pocket,home,parsed);
        instructions.push(...prepared.instructions);cost=prepared.rent;extraSigners=prepared.signers;
        tokenPairs=prepared.pairs.map(p=>({source:p.source.toBase58(),destination:p.destination.toBase58(),mint:p.mint.toBase58()}));
        instructions.push(
          sweepHomeIx({
            payer: payer.publicKey,
            pocket,
            home,
            auth: proof,
            tokenPairs: prepared.pairs,
          }),
        );
        break;
      }
      case "revoke":
        instructions.push(revokeSessionIx({ payer: payer.publicKey, pocket, auth: proof }));
        break;
      case "propose": {
        const change = hex(req.changeHex, undefined, "changeHex");
        if (change[0] === 0 && change.length === 33) {
          instructions.push(
            proposeChangeIx({
              payer: payer.publicKey,
              pocket,
              change: { home: new PublicKey(change.subarray(1)) },
              proof,
            }),
          );
        } else {
          throw badRequest("policy changes go through proposePolicy (todo M2)");
        }
        break;
      }
      case "cancel":
        instructions.push(cancelChangeIx({ payer: payer.publicKey, pocket, proof }));
        break;
      default:
        throw badRequest("unknown action");
    }
    return { instructions, rent: cost, signers: extraSigners, tokenPairs };
  });

  // Convenience: derive a pocket address for an app id (read-only).
  router.get("/pocket/:appIdHex", async ({ params }) => {
    const appId = hex(params.appIdHex, 32, "appIdHex");
    return { json: { pocket: pocketPda(appId).toBase58() } };
  });

  const server = Object.assign(router.server(), { drain: () => { draining = true; } });
  return Object.defineProperty(server, "active", { get: () => active }) as Server & { drain(): void; readonly active: number };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("expected a JSON object");
  return value as Record<string, unknown>;
}

function hex(value: unknown, length: number | undefined, field: string): Uint8Array {
  if (typeof value !== "string") throw badRequest(`${field} required`);
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(value);
  } catch {
    throw badRequest(`${field} must be hex`);
  }
  if (length !== undefined && bytes.length !== length) throw badRequest(`${field} must be ${length} bytes`);
  return bytes;
}

function pubkey(value: unknown, field: string): PublicKey {
  if (typeof value !== "string") throw badRequest(`${field} required`);
  try {
    return new PublicKey(value);
  } catch {
    throw badRequest(`${field} must be a base58 public key`);
  }
}

function u64(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw badRequest(`${field} must be a decimal string`);
  const v = BigInt(value);
  if (v > 0xffffffffffffffffn) throw badRequest(`${field} exceeds u64`);
  return v;
}

export { bs58 };
