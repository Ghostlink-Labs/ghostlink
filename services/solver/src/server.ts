/**
 * The reference solver. Fill shape (build plan 4.4):
 *   [precompile over SHA-256(intent)] [fill_begin] [route] [fill_end]
 * all in one transaction — the route either delivers out_min or the
 * whole thing reverts, solver fee included.
 *
 * Routing is pluggable. The mock planner transfers from the solver's own
 * inventory (localnet/devnet, where DEX liquidity is thin — accepted by
 * the M2 gate); a Jupiter planner belongs here when mainnet routing
 * lands (docs/adr/0001). Whatever the planner, the server values both
 * legs first and refuses to overpay (economics.ts).
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
import { sha256 } from "@noble/hashes/sha256";
import type { IntentRequest } from "@ghostlink/common";
import {
  HttpError,
  RateLimiter,
  Router,
  Semaphore,
  ataAddress,
  clientIp,
  createAtaIdempotentIx,
  ed25519Ix,
  fillBeginIx,
  fillEndIx,
  secp256r1Ix,
  splTransferIx,
} from "@ghostlink/service-kit";
import { validateIntent, type ValidatedIntent } from "./validate.js";
import { PriceReader, checkEconomics } from "./economics.js";

export interface RoutePlan {
  instructions: TransactionInstruction[];
}

export interface RoutePlanner {
  plan(v: ValidatedIntent, solver: PublicKey): Promise<RoutePlan>;
}

/** Fills from the solver's own token inventory at the intent's terms. */
export class MockPlanner implements RoutePlanner {
  async plan(v: ValidatedIntent, solver: PublicKey): Promise<RoutePlan> {
    const outMint = new PublicKey(v.intent.outMint);
    const pocket = new PublicKey(v.intent.pocket);
    const source = ataAddress(solver, outMint);
    const destination = ataAddress(pocket, outMint);
    return {
      instructions: [splTransferIx(source, destination, solver, v.intent.outMin)],
    };
  }
}

export interface SolverDeps {
  connection: Connection;
  keypair: Keypair;
  planner: RoutePlanner;
  /** mint base58 -> Pyth price update account base58 (user-pinned feeds). */
  priceAccounts: Record<string, string>;
  /** How much more than the input's value the solver will deliver; default 100 bps. */
  maxQuoteSpreadBps?: number;
  /** Fill output mints that have no price (NFT-style); default false. */
  allowUnpriced?: boolean;
  /**
   * Pay rent for the pocket's output token account when it is missing.
   * Default false: that rent goes to the user's home on sweep, so an
   * attacker could farm it; the funding flow creates the account instead.
   */
  createPocketAta?: boolean;
  trustProxy?: boolean;
}

export function buildServer(deps: SolverDeps): Server {
  const router = new Router();
  const solver = deps.keypair.publicKey;
  const prices = new PriceReader(deps.connection, deps.priceAccounts);
  const ipLimiter = new RateLimiter(30, 60_000);
  const pocketLimiter = new RateLimiter(10, 60_000);
  const inFlight = new Semaphore(8);
  const locked = new Set<string>();

  router.get("/health", async () => ({ json: { ok: true, solver: solver.toBase58() } }));

  router.post("/intent", async ({ body, raw }) => {
    if (!ipLimiter.allow(clientIp(raw, deps.trustProxy))) throw new HttpError(429, "rate limited");
    const req = body as IntentRequest;
    let v: ValidatedIntent;
    try {
      v = validateIntent(req);
    } catch (e) {
      return { status: 400, json: { error: e instanceof Error ? e.message : String(e) } };
    }

    const pocket = new PublicKey(v.intent.pocket);
    const inMint = new PublicKey(v.intent.inMint);
    const outMint = new PublicKey(v.intent.outMint);
    if (!pocketLimiter.allow(pocket.toBase58())) throw new HttpError(429, "rate limited for this pocket");

    const inPrice = await prices.priceFor(inMint);
    if (!inPrice) {
      return { status: 400, json: { error: `no price account configured for ${inMint.toBase58()}` } };
    }
    const outPrice = await prices.priceFor(outMint);
    const economics = checkEconomics(
      v.intent,
      { in: inPrice, out: outPrice },
      deps.maxQuoteSpreadBps ?? 100,
      deps.allowUnpriced ?? false,
    );
    if (!economics.ok) return { status: 400, json: { error: economics.reason } };

    // One attempt per (pocket, nonce) at a time: a second request would
    // only burn a fee racing the first.
    const lockKey = `${pocket.toBase58()}:${v.intent.nonce}`;
    if (locked.has(lockKey)) throw new HttpError(409, "this intent is already being filled");
    locked.add(lockKey);
    try {
      return await inFlight.run(() => fill(v, pocket, inMint, outMint));
    } finally {
      locked.delete(lockKey);
    }
  });

  async function fill(v: ValidatedIntent, pocket: PublicKey, inMint: PublicKey, outMint: PublicKey) {
    const pre =
      v.sessionKind === 0
        ? ed25519Ix(v.sessionKey, v.signature, v.hash)
        : secp256r1Ix(v.sessionKey, v.signature, webauthnMessage(v));

    const intentFields = {
      nonce: v.intent.nonce,
      inMint,
      inMax: v.intent.inMax,
      outMint,
      outMin: v.intent.outMin,
      deadlineSlot: v.intent.deadlineSlot,
      policyHash: v.intent.policyHash,
    };
    const inPriceAccount = new PublicKey(deps.priceAccounts[inMint.toBase58()]!);
    const outPriceAccount = deps.priceAccounts[outMint.toBase58()];

    const route = await deps.planner.plan(v, solver);
    const begin = fillBeginIx({
      solver,
      pocket,
      pocketIn: ataAddress(pocket, inMint),
      solverIn: ataAddress(solver, inMint),
      pocketOut: ataAddress(pocket, outMint),
      inPrice: inPriceAccount,
      intent: intentFields,
      webauthn: v.webauthn
        ? { authenticatorData: v.webauthn.authenticatorData, clientDataJson: v.webauthn.clientDataJson }
        : undefined,
    });
    const end = fillEndIx({
      solver,
      pocket,
      pocketOut: ataAddress(pocket, outMint),
      outPrice: outPriceAccount ? new PublicKey(outPriceAccount) : undefined,
      intent: intentFields,
    });

    const setup: TransactionInstruction[] = [createAtaIdempotentIx(solver, solver, inMint)];
    if (deps.createPocketAta) setup.push(createAtaIdempotentIx(solver, pocket, outMint));

    const tx = new Transaction().add(...setup, pre, begin, ...route.instructions, end);
    tx.feePayer = solver;
    const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(deps.keypair);
    try {
      const signature = await deps.connection.sendRawTransaction(tx.serialize());
      const status = await deps.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (status.value.err) {
        return { status: 502, json: { error: `fill failed on-chain: ${JSON.stringify(status.value.err)}`, signature } };
      }
      return { json: { signature } };
    } catch (e) {
      return { status: 502, json: { error: e instanceof Error ? e.message : String(e) } };
    }
  }

  return router.server();
}

function webauthnMessage(v: ValidatedIntent): Uint8Array {
  if (!v.webauthn) throw new Error("unreachable");
  const out = new Uint8Array(v.webauthn.authenticatorData.length + 32);
  out.set(v.webauthn.authenticatorData, 0);
  out.set(sha256(v.webauthn.clientDataJson), v.webauthn.authenticatorData.length);
  return out;
}

export { bs58 };
