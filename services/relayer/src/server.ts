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
  RateLimiter,
  Router,
  Semaphore,
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
import {
  BINDING_RENT_LAMPORTS,
  POCKET_RENT_LAMPORTS,
  SpendMeter,
} from "./budget.js";

export interface RelayerDeps {
  connection: Connection;
  payer: Keypair;
  /** Lamports a wallet must hold before we pay for its registration. */
  minWalletLamports?: bigint;
  /** Rolling 24 h spend ceiling; default 2 SOL. */
  dailyBudgetLamports?: bigint;
  /** Atomic spend snapshot; use one file per payer process for restart durability. */
  budgetPersistPath?: string;
  /** Lowercase hex domain hashes whose pockets this relayer creates; unset = any. */
  allowedDomainHashes?: Set<string>;
  /** Honour X-Forwarded-For (only behind a proxy you control). */
  trustProxy?: boolean;
  /** Transactions in flight at once; default 8. */
  maxInFlight?: number;
}

const MAX_TOKEN_PAIRS = 16;

export function buildServer(deps: RelayerDeps): Server {
  const { connection, payer } = deps;
  const minLamports = deps.minWalletLamports ?? 10_000_000n; // 0.01 SOL
  const meter = new SpendMeter(deps.dailyBudgetLamports ?? 2_000_000_000n, undefined, deps.budgetPersistPath);
  const ipLimiter = new RateLimiter(30, 60_000);
  const walletLimiter = new RateLimiter(3, 60_000);
  const snapshotLimiter = new RateLimiter(1, 60_000);
  const inFlight = new Semaphore(deps.maxInFlight ?? 8);
  const router = new Router();

  function throttle(raw: Parameters<typeof clientIp>[0]): void {
    if (!ipLimiter.allow(clientIp(raw, deps.trustProxy))) throw new HttpError(429, "rate limited");
  }

  function charge(lamports: bigint): void {
    if (!meter.tryCharge(lamports)) {
      throw new HttpError(503, "relayer daily budget exhausted; try again later");
    }
  }

  async function sendTx(instructions: TransactionInstruction[], rent: bigint, signers: Keypair[] = []): Promise<{ signature: string }> {
    return inFlight.run(async () => {
      const tx = new Transaction().add(...instructions);
      tx.feePayer = payer.publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.sign(payer, ...signers);
      // Serialize and obtain the full fee (including signature precompiles)
      // before reserving. Nothing asynchronous sits between charge and send.
      const bytes = tx.serialize();
      const fee = (await connection.getFeeForMessage(tx.compileMessage(), "confirmed")).value;
      if (fee === null) throw new HttpError(503, "transaction fee unavailable; try again later");
      charge(rent + BigInt(fee));
      let signature: string;
      try {
        signature = await connection.sendRawTransaction(bytes);
      } catch (e) {
        // A timeout does not establish that the RPC failed to broadcast.
        // Keep the charge until it ages out rather than risk overspending.
        throw new HttpError(502, `transaction rejected: ${firstLine(e)}`);
      }
      const status = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (status.value.err) {
        throw new HttpError(502, `transaction ${signature} failed on-chain: ${JSON.stringify(status.value.err)}`);
      }
      return { signature };
    });
  }

  router.get("/health", async () => ({
    json: {
      ok: true,
      payer: payer.publicKey.toBase58(),
      spentLamports24h: meter.spentInWindow().toString(),
      dailyBudgetLamports: meter.dailyBudgetLamports.toString(),
      restrictedToPartners: Boolean(deps.allowedDomainHashes),
    },
  }));

  router.post("/register", async ({ body, raw }) => {
    throttle(raw);
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
    return { json: await sendTx([pre, reg], BINDING_RENT_LAMPORTS) };
  });

  router.post("/snapshot", async ({ body, raw }) => {
    throttle(raw);
    const req = objectBody(body) as Partial<SnapshotRequest>;
    const wallet = pubkey(req.wallet, "wallet");
    const holding = pubkey(req.holding, "holding");
    // One snapshot per (wallet, holding) per minute: a burst of
    // snapshots would also churn the census root ring under live proofs.
    if (!snapshotLimiter.allow(`${wallet.toBase58()}:${holding.toBase58()}`)) {
      throw new HttpError(429, "that holding was snapshotted less than a minute ago");
    }
    const ix = snapshotIx(payer.publicKey, wallet, holding);
    return { json: await sendTx([ix], 0n) };
  });

  router.post("/open-session", async ({ body, raw }) => {
    throttle(raw);
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
    return { json: await sendTx([computeBudget(400_000), ix], exists ? 0n : POCKET_RENT_LAMPORTS) };
  });

  router.post("/owner-action", async ({ body, raw }) => {
    throttle(raw);
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
    return { json: { ...await sendTx(instructions, cost, extraSigners), ...(tokenPairs ? {tokenPairs} : {}) } };
  });

  // Convenience: derive a pocket address for an app id (read-only).
  router.get("/pocket/:appIdHex", async ({ params }) => {
    const appId = hex(params.appIdHex, 32, "appIdHex");
    return { json: { pocket: pocketPda(appId).toBase58() } };
  });

  return router.server();
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

function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split("\n")[0] ?? text;
}

export { bs58 };
