import { performance } from "node:perf_hooks";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { ataAddress, createAtaIdempotentIx, TOKEN } from "@ghostlink/service-kit";
import type { RoutePlan, RoutePlanner } from "./server.js";
import type { ValidatedIntent } from "./validate.js";
import type { LookupTableRequest } from "./transactions.js";
import { RAYDIUM_CP, RAYDIUM_AUTHORITY, RouteRefused, requireRoute, readPool, checkPoolSnapshot,
  checkToken, readRouteAccounts, type ApprovedPool, type RouteChain } from "./raydium.js";

export const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const EVENT = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], JUPITER)[0];
const ROUTE_V2 = Buffer.from([187, 100, 250, 204, 49, 196, 175, 20]);
const SHARED_V2 = Buffer.from([209, 152, 83, 147, 124, 254, 216, 233]);
const ENDPOINT = "https://api.jup.ag/swap/v2/build";
const MAX_BODY = 262_144;
const U64 = 0xffffffffffffffffn;
type Json = Record<string, unknown>;
function object(v: unknown): Json { requireRoute(v !== null && typeof v === "object" && !Array.isArray(v), "invalid provider object"); return v as Json; }
function list(v: unknown, max: number): unknown[] { requireRoute(Array.isArray(v) && v.length <= max, "unsupported provider list"); return v; }
function pubkey(v: unknown): PublicKey {
  requireRoute(typeof v === "string" && v.length <= 44, "invalid provider address");
  try { const p = new PublicKey(v); requireRoute(p.toBase58() === v, "noncanonical provider address"); return p; }
  catch { throw new RouteRefused("invalid provider address"); }
}
function amount(v: unknown): bigint {
  requireRoute(typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v), "invalid provider amount");
  const n = BigInt(v); requireRoute(n <= U64, "provider amount exceeds u64"); return n;
}
function instruction(v: unknown): TransactionInstruction {
  const x = object(v), programId = pubkey(x.programId);
  requireRoute(typeof x.data === "string" && x.data.length <= 2_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(x.data), "invalid instruction encoding");
  const data = Buffer.from(x.data, "base64"); requireRoute(data.toString("base64") === x.data, "noncanonical instruction encoding");
  const keys = list(x.accounts, 64).map(a => { const k = object(a);
    requireRoute(typeof k.isSigner === "boolean" && typeof k.isWritable === "boolean", "invalid instruction permissions");
    return { pubkey: pubkey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable };
  });
  return new TransactionInstruction({ programId, data, keys });
}
function sameInstruction(a: TransactionInstruction, b: TransactionInstruction) {
  return a.programId.equals(b.programId) && a.data.equals(b.data) && a.keys.length === b.keys.length && a.keys.every((k, i) => {
    const other = b.keys[i]!; return k.pubkey.equals(other.pubkey) && k.isSigner === other.isSigner && k.isWritable === other.isWritable;
  });
}
function meta(pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta { return { pubkey, isWritable, isSigner }; }

export interface JupiterOptions {
  apiKey: string;
  pools: readonly ApprovedPool[];
  /** Exact requested tolerance, maximum 500 bps. User outMin remains a separate, stricter floor. */
  slippageBps: number;
}

/** Fixed-origin, bounded request. Never includes provider body/transport exceptions in errors. */
export async function fetchJupiterBuild(query: URLSearchParams, apiKey: string, fetcher: typeof fetch = globalThis.fetch): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(`${ENDPOINT}?${query}`, { method: "GET", redirect: "error",
      headers: { "x-api-key": apiKey, accept: "application/json", "cache-control": "no-store" }, signal: controller.signal });
    requireRoute(response.ok && response.status === 200 && !response.redirected &&
      /^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") && response.body, "Jupiter build unavailable");
    const declared = response.headers.get("content-length");
    requireRoute(declared === null || (/^[0-9]+$/.test(declared) && Number(declared) <= MAX_BODY), "Jupiter response too large");
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; requireRoute(size <= MAX_BODY, "Jupiter response too large"); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof RouteRefused) throw error;
    throw new RouteRefused("Jupiter build unavailable");
  } finally { clearTimeout(timeout); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
}

/** Experimental composable adapter. Only one reviewed Raydium CP hop, classic SPL, V2 ExactIn. */
export class JupiterPlanner implements RoutePlanner {
  readonly funding = "intent-input" as const;
  readonly #options: JupiterOptions;
  constructor(private readonly chain: RouteChain, options: JupiterOptions, private readonly fetcher: typeof fetch = globalThis.fetch) {
    requireRoute(typeof options.apiKey === "string" && options.apiKey.length > 0 && options.apiKey.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(options.apiKey), "invalid Jupiter API key configuration");
    requireRoute(Number.isInteger(options.slippageBps) && options.slippageBps >= 0 && options.slippageBps <= 500, "unsupported slippage setting");
    requireRoute(options.pools.length > 0 && options.pools.length <= 64, "approved pools required");
    const seen = new Set<string>();
    for (const p of options.pools) {
      pubkey(p.pool); pubkey(p.token0); pubkey(p.token1);
      requireRoute(p.token0 !== p.token1 && !seen.has(p.pool) && Number.isSafeInteger(p.maxTradeFeePpm) &&
        p.maxTradeFeePpm >= 0 && p.maxTradeFeePpm <= 50_000, "invalid pool approval"); seen.add(p.pool);
    }
    this.#options = { ...options, pools: options.pools.map(p => ({ ...p })) };
  }

  async plan(v: ValidatedIntent, solver: PublicKey, minimumSlot = 0): Promise<RoutePlan> {
    // Copy all caller-controlled intent and key bytes before the first await.
    const input = new PublicKey(Uint8Array.from(v.intent.inMint)), output = new PublicKey(Uint8Array.from(v.intent.outMint));
    const pocket = new PublicKey(Uint8Array.from(v.intent.pocket)), payer = new PublicKey(solver.toBytes());
    const inMax = v.intent.inMax, outMin = v.intent.outMin, deadline = v.intent.deadlineSlot;
    requireRoute(Number.isSafeInteger(minimumSlot) && minimumSlot >= 0 && inMax > 0n && inMax <= U64 && outMin > 0n && outMin <= U64 && deadline >= 0n && deadline <= U64 &&
      !input.equals(output) && !payer.equals(pocket), "invalid route intent");
    const candidates = this.#options.pools.filter(p => (p.token0 === input.toBase58() && p.token1 === output.toBase58()) ||
      (p.token1 === input.toBase58() && p.token0 === output.toBase58()));
    requireRoute(candidates.length > 0, "token pair has no approved pool");
    const source = ataAddress(payer, input), destination = ataAddress(pocket, output), started = performance.now();
    const query = new URLSearchParams({ inputMint: input.toBase58(), outputMint: output.toBase58(), amount: inMax.toString(),
      taker: payer.toBase58(), payer: payer.toBase58(), destinationTokenAccount: destination.toBase58(),
      wrapAndUnwrapSol: "false", platformFeeBps: "0", slippageBps: this.#options.slippageBps.toString(),
      dexes: "Raydium CP", transactionVersion: "0", maxAccounts: "32" });
    const result = object(await fetchJupiterBuild(query, this.#options.apiKey, this.fetcher));
    requireRoute(result.inputMint === input.toBase58() && result.outputMint === output.toBase58() &&
      amount(result.inAmount) === inMax && result.swapMode === "ExactIn" && result.slippageBps === this.#options.slippageBps && result.transactionVersion === 0,
    "Jupiter quote differs from requested intent");
    const quoted = amount(result.outAmount), threshold = amount(result.otherAmountThreshold);
    const floor = quoted * BigInt(10_000 - this.#options.slippageBps) / 10_000n;
    requireRoute(quoted > 0n && threshold >= outMin && threshold <= quoted && floor >= outMin && threshold >= floor,
      "Jupiter output below intent minimum");
    const steps = list(result.routePlan, 1); requireRoute(steps.length === 1, "only single-hop routes supported");
    const step = object(steps[0]), info = object(step.swapInfo);
    requireRoute(step.percent === 100 && (step.bps === undefined || step.bps === 10_000) && info.label === "Raydium CP" &&
      info.inputMint === input.toBase58() && info.outputMint === output.toBase58() && amount(info.inAmount) === inMax && amount(info.outAmount) === quoted,
    "unsupported Jupiter route plan");
    const approval = candidates.find(p => p.pool === info.ammKey); requireRoute(approval, "Jupiter selected an unapproved pool");
    requireRoute(result.cleanupInstruction == null && result.tipInstruction == null && list(result.otherInstructions, 0).length === 0,
      "unexpected cleanup, tip or auxiliary instruction");
    // Never execute provider budget or setup instructions. Accept only a redundant source ATA creation.
    for (const raw of list(result.computeBudgetInstructions, 2)) {
      const ix = instruction(raw);
      requireRoute(ix.programId.equals(ComputeBudgetProgram.programId) && ix.keys.length === 0 &&
        ((ix.data.length === 5 && ix.data[0] === 2) || (ix.data.length === 9 && ix.data[0] === 3)), "unexpected compute instruction");
    }
    for (const raw of list(result.setupInstructions, 1)) requireRoute(sameInstruction(instruction(raw), createAtaIdempotentIx(payer, payer, input)), "unexpected setup or rent payment");
    const swap = instruction(result.swapInstruction);
    requireRoute(swap.programId.equals(JUPITER), "unexpected swap program");
    const shared = swap.data.subarray(0, 8).equals(SHARED_V2);
    requireRoute(shared || swap.data.subarray(0, 8).equals(ROUTE_V2), "unsupported Jupiter instruction variant");
    const offset = shared ? 9 : 8;
    requireRoute(swap.data.length === offset + 31, "unsupported Jupiter instruction length");
    requireRoute(swap.data.readBigUInt64LE(offset) === inMax && swap.data.readBigUInt64LE(offset + 8) === quoted &&
      swap.data.readUInt16LE(offset + 16) === this.#options.slippageBps && swap.data.readUInt16LE(offset + 18) === 0 &&
      swap.data.readUInt16LE(offset + 20) === 0 && swap.data.readUInt32LE(offset + 22) === 1 && swap.data[offset + 26] === 46 &&
      swap.data.readUInt16LE(offset + 27) === 10_000 && swap.data[offset + 29] === 0 && swap.data[offset + 30] === 1,
    "swap arguments, fees or route differ from quote");
    const authority = shared ? PublicKey.findProgramAddressSync([Buffer.from("authority"), swap.data.subarray(8, 9)], JUPITER)[0] : payer;
    if (shared) requireRoute(swap.data[8]! < 16, "unsupported Jupiter authority");
    const routeSource = shared ? ataAddress(authority, input) : source;
    const head = shared ? 12 : 10;
    requireRoute(swap.keys.length === head + 14, "unexpected remaining swap accounts");
    // Jupiter can write directly into the pocket or use its own destination ATA before forwarding.
    const sharedDestination = shared ? ataAddress(authority, output) : destination;
    const routeDestination = shared && swap.keys[4]!.pubkey.equals(sharedDestination) ? sharedDestination : destination;
    const first = await readRouteAccounts(this.chain, [new PublicKey(approval.pool)], minimumSlot, deadline);
    const pool = readPool(first.value[0], approval);
    const forward = input.equals(pool.mint0);
    const prefix = shared ? [meta(authority), meta(payer, false, true), meta(source, true), meta(routeSource, true), meta(routeDestination, true),
      meta(destination, true), meta(input), meta(output), meta(TOKEN), meta(TOKEN), meta(EVENT), meta(JUPITER)] :
      [meta(payer, false, true), meta(source, true), meta(destination, true), meta(input), meta(output), meta(TOKEN), meta(TOKEN),
        meta(swap.keys[7]!.pubkey.equals(destination) ? destination : JUPITER, swap.keys[7]!.pubkey.equals(destination)), meta(EVENT), meta(JUPITER)];
    const expected = [...prefix, meta(RAYDIUM_CP), meta(authority, false, !shared), meta(RAYDIUM_AUTHORITY), meta(pool.config), meta(pool.address, true),
      meta(routeSource, true), meta(routeDestination, true), meta(forward ? pool.vault0 : pool.vault1, true), meta(forward ? pool.vault1 : pool.vault0, true),
      meta(TOKEN), meta(TOKEN), meta(input), meta(output), meta(pool.observation, true)];
    requireRoute(swap.keys.every((k, i) => k.pubkey.equals(expected[i]!.pubkey) &&
      k.isSigner === expected[i]!.isSigner && (k.isWritable === expected[i]!.isWritable || (k.pubkey.equals(payer) && k.isWritable))),
    "swap accounts or permissions differ from approved route");
    const keys = [pool.address, pool.config, pool.vault0, pool.vault1, pool.mint0, pool.mint1, pool.observation, source, destination, JUPITER, RAYDIUM_CP];
    if (shared) { keys.push(routeSource); if (!routeDestination.equals(destination)) keys.push(routeDestination); }
    const snapshot = await readRouteAccounts(this.chain, keys, first.context.slot, deadline);
    checkPoolSnapshot(snapshot.value, approval, pool);
    if (snapshot.value[7]) checkToken(snapshot.value[7], input, payer); // Server creates this exact ATA if absent.
    checkToken(snapshot.value[8], output, pocket); // Owner pays output rent before asking for a trade.
    for (const n of [9, 10]) requireRoute(snapshot.value[n]?.executable, "route program is not executable");
    if (shared) { checkToken(snapshot.value[11], input, authority); if (keys.length > 12) checkToken(snapshot.value[12], output, authority); }
    const lookupTables: LookupTableRequest[] = [];
    if (result.addressesByLookupTableAddress != null) {
      const mapping = object(result.addressesByLookupTableAddress);
      requireRoute(Object.keys(mapping).length <= 8, "too many route lookup tables");
      for (const [address, values] of Object.entries(mapping)) {
        const addresses = list(values, 256).map(pubkey); requireRoute(addresses.length > 0, "empty route lookup table");
        lookupTables.push({ address: pubkey(address), addresses });
      }
    }
    requireRoute(performance.now() - started <= 8_000, "route expired during preparation");
    return { instructions: [swap], lookupTables, minimumSlot: snapshot.context.slot };
  }
}
