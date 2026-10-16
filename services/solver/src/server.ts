/**
 * The reference solver. Fill shape (build plan 4.4):
 *   [precompile over SHA-256(intent)] [fill_begin] [route] [fill_end]
 * all in one transaction — token movements revert together if out_min
 * is not delivered. Solana network fees can still be charged on failure.
 *
 * Routing is pluggable. The mock planner transfers from the solver's own
 * inventory on the local validator; the experimental Jupiter planner validates
 * one approved Raydium CP hop (docs/JUPITER-ROUTING.md). The server values both
 * legs first and refuses to overpay (economics.ts).
 */
import type { Server } from "node:http";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha256";
import type { IntentRequest } from "@ghostlink/common";
import {
  HttpError,
  RateLimiter,
  Router,
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
import { NonceConflictError, SubmissionJournal } from "./journal.js";
import { IntentAuthorizationError, SubmissionCoordinator } from "./submission.js";
import { prepareVersionedTransaction, type LookupTableRequest, type TransactionLimits } from "./transactions.js";

export interface RoutePlan {
  instructions: TransactionInstruction[];
  lookupTables?: LookupTableRequest[];
  /** Bank used to validate route accounts; later composition must not regress. */
  minimumSlot?: number;
}

export interface RoutePlanner {
  /** Opt-in contract: output comes solely from swapping the exact intent input. */
  readonly funding?: "intent-input";
  plan(v: ValidatedIntent, solver: PublicKey, minimumSlot?: number): Promise<RoutePlan>;
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
  journal: SubmissionJournal;
  transactionLimits?: TransactionLimits;
  /** mint base58 -> Pyth price update account base58 (user-pinned feeds). */
  priceAccounts: Record<string, string>;
  /** How much more than the input's value the solver will deliver; default 100 bps. */
  maxQuoteSpreadBps?: number;
  /** Allow unpriced legs with an intent-funded planner; default false. Owner policy still applies. */
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
  const router = new Router({ exposeErrors: false, onError: () => console.error("solver request failed") });
  const solver = deps.keypair.publicKey;
  if (deps.journal.scope.solver !== solver.toBase58()) throw new Error("solver identity does not match journal");
  const submissions = new SubmissionCoordinator(deps.connection, deps.journal);
  const prices = new PriceReader(deps.connection, deps.priceAccounts);
  const ipLimiter = new RateLimiter(30, 60_000);
  const pocketLimiter = new RateLimiter(10, 60_000);
  let inFlight = 0;

  router.get("/health", async () => ({ json: { ok: true, solver: solver.toBase58() } }));

  router.get("/intents/:id", async ({ params, raw }) => {
    if (!ipLimiter.allow(clientIp(raw, deps.trustProxy))) throw new HttpError(429, "rate limited");
    if (!/^[0-9a-f]{64}$/.test(params.id ?? "")) throw new HttpError(400, "invalid intent hash");
    if (!deps.journal.get(params.id!)) throw new HttpError(404, "intent not found");
    if (inFlight >= 8) throw new HttpError(503, "solver busy");
    inFlight += 1;
    try { return { json: await submissions.status(params.id!), headers: { "cache-control": "no-store" } }; }
    finally { inFlight -= 1; }
  });

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

    if (inFlight >= 8) throw new HttpError(503, "solver busy; retry the same signed intent");
    inFlight += 1;
    try {
      const result = await submissions.submit(v, async minimumSlot => {
        const inPrice = await prices.priceFor(inMint);
        const outPrice = await prices.priceFor(outMint);
        if ((!inPrice || !outPrice) && (!deps.allowUnpriced || deps.planner.funding !== "intent-input")) {
          throw new HttpError(400, "unpriced trades require an enabled intent-funded swap planner");
        }
        const economics = checkEconomics(v.intent, { in: inPrice, out: outPrice },
          deps.maxQuoteSpreadBps ?? 100, deps.allowUnpriced ?? false);
        if (!economics.ok) throw new HttpError(400, economics.reason ?? "quote refused");
        return prepare(v, pocket, inMint, outMint, minimumSlot);
      });
      return { status: ["preparing", "pending", "unknown"].includes(result.state) ? 202 : 200,
        json: result, headers: { "cache-control": "no-store" } };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof NonceConflictError) throw new HttpError(409, error.message);
      if (error instanceof IntentAuthorizationError) throw new HttpError(403, "intent is not authorized by the current pocket");
      throw new HttpError(503, "intent preparation unavailable; retry the identical signed intent");
    } finally { inFlight -= 1; }
  });

  async function prepare(v: ValidatedIntent, pocket: PublicKey, inMint: PublicKey, outMint: PublicKey, minimumSlot: number) {
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
    // Unpriced exits have no input oracle. The program classifies the leg
    // from the owner-pinned policy and ignores this placeholder only then.
    const inPriceAccount = deps.priceAccounts[inMint.toBase58()]
      ? new PublicKey(deps.priceAccounts[inMint.toBase58()]!) : pocket;
    const outPriceAccount = deps.priceAccounts[outMint.toBase58()];

    const route = await deps.planner.plan(v, solver, minimumSlot);
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

    return prepareVersionedTransaction(deps.connection, deps.keypair, {
      instructions: [...setup, pre, begin, ...route.instructions, end], lookupTables: route.lookupTables,
      minimumSlot: Math.max(minimumSlot, route.minimumSlot ?? minimumSlot), deadlineSlot: v.intent.deadlineSlot, limits: deps.transactionLimits,
    });
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
