/** Node-only, operator-configured HTTP RPC failover. No wallet or key custody. */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Connection, type Commitment, type FetchFn, type TransactionConfirmationStrategy } from "@solana/web3.js";
import bs58 from "bs58";

type Level = "processed" | "confirmed" | "finalized";
type Reason = "transport" | "timeout" | "http" | "malformed" | "genesis" | "stale" | "unhealthy";
type Request = { jsonrpc: "2.0"; id: string | number; method: string; params?: unknown[] };
type Reply = { jsonrpc: "2.0"; id: string | number; result?: unknown; error?: { code: number; message: string } };
export interface RpcEndpoint { url: string; headers?: Readonly<Record<string, string>> }

/** Operator-only file; never include its path, contents or parser diagnostics in errors. */
export function loadRpcEndpoints(path?: string, fallbackUrl = "http://127.0.0.1:8899"): RpcEndpoint[] {
  if (!path) return [{ url: fallbackUrl }];
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 16_384) throw new Error();
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > 16_384) throw new Error();
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length < 1 || value.length > 4 ||
      value.some(endpoint => !object(endpoint) || typeof endpoint.url !== "string")) throw new Error();
    return value as RpcEndpoint[]; // createRpcPool validates URLs and headers before any request.
  } catch { throw new Error("RPC_ENDPOINTS_PATH must name a bounded valid endpoint configuration file"); }
}
export interface RpcPoolOptions {
  endpoints: readonly RpcEndpoint[];
  genesisHash: string;
  commitment?: Level;
  /** Covers genesis probe AND business request for one endpoint. */
  endpointTimeoutMs?: number;
  /** Whole HTTP operation; keep below the caller's operation deadline. */
  requestTimeoutMs?: number;
  confirmationTimeoutMs?: number;
  pollIntervalMs?: number;
  maxResponseBytes?: number;
}
export class RpcPoolError extends Error {
  constructor(readonly code: "unavailable" | "aborted" | "closed" | "unsupported" | "capacity" | "confirmation-expired") {
    super(`RPC pool ${code}`); this.name = "RpcPoolError";
  }
}
class EndpointFailure extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}
const contextual = new Set(["getAccountInfo", "getMultipleAccounts", "getBalance", "getLatestBlockhash",
  "getFeeForMessage", "getTokenAccountBalance", "getTokenSupply", "getSignatureStatuses", "isBlockhashValid", "simulateTransaction"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const slotNumber = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function level(value: unknown): Level {
  if (value === "processed" || value === "confirmed" || value === "finalized") return value;
  throw new RpcPoolError("unsupported");
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error("Invalid RPC pool limit");
  return n;
}

/**
 * A Connection-compatible HTTP transport for bot authorization and solver reads,
 * simulation, raw signed sends and confirmation. WebSocket subscriptions, batch
 * RPC and durable-nonce confirmation are deliberately unsupported. A successful
 * send is only an acknowledgment; durable outcome reconciliation belongs to the
 * caller. The pool never prepares, signs, or changes a serialized transaction.
 */
export function createRpcPool(options: RpcPoolOptions) {
  const approvedGenesis = options.genesisHash;
  let genesis: Uint8Array;
  try { genesis = bs58.decode(options.genesisHash); } catch { throw new Error("Invalid approved RPC genesis"); }
  if (genesis.length !== 32) throw new Error("Invalid approved RPC genesis");
  if (!Array.isArray(options.endpoints) || options.endpoints.length < 1 || options.endpoints.length > 4) throw new Error("RPC pool requires 1..4 endpoints");
  const endpoints = options.endpoints.map(endpoint => {
    let url: URL;
    try { url = new URL(endpoint.url); } catch { throw new Error("Invalid RPC endpoint configuration"); }
    if (url.username || url.password || url.hash || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
      throw new Error("RPC endpoints require HTTPS or loopback HTTP, without userinfo or fragments");
    }
    const headers = new Headers({ "content-type": "application/json" });
    try {
      for (const [name, value] of Object.entries(endpoint.headers ?? {})) {
        if (!/^(authorization|x-[a-z0-9-]+)$/i.test(name) || typeof value !== "string") throw new Error();
        headers.set(name, value);
      }
    } catch { throw new Error("Invalid RPC authentication headers"); }
    return { url: url.href, headers, failures: 0, reason: undefined as Reason | undefined, retryAt: 0, quarantined: false };
  });
  const commitment = level(options.commitment ?? "confirmed");
  const endpointMs = bounded(options.endpointTimeoutMs, 1500, 25, 5000);
  const requestMs = bounded(options.requestTimeoutMs, 6000, endpointMs, 6000);
  const confirmMs = bounded(options.confirmationTimeoutMs, 60_000, 100, 120_000);
  const pollMs = bounded(options.pollIntervalMs, 400, 10, 5000);
  const maxBytes = bounded(options.maxResponseBytes, 4 * 1024 * 1024, 1024, 16 * 1024 * 1024);
  const shutdown = new AbortController();
  const confirmationScope = new AsyncLocalStorage<AbortSignal>();
  const floors: Record<Level, number> = { processed: 0, confirmed: 0, finalized: 0 };
  const floor = (l: Level) => Math.max(floors[l], floors.finalized, l === "processed" ? floors.confirmed : 0);
  let preferred = 0, active = 0;

  async function exchange(endpoint: typeof endpoints[number], request: Request, body: string, signal: AbortSignal): Promise<Reply> {
    let response: Response;
    try {
      response = await fetch(endpoint.url, { method: "POST", body, headers: endpoint.headers, signal, redirect: "error" });
    } catch { throw new EndpointFailure(signal.aborted ? "timeout" : "transport"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EndpointFailure("http");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new EndpointFailure("malformed");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new EndpointFailure("malformed");
        chunks.push(value);
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e instanceof EndpointFailure ? e : new EndpointFailure(signal.aborted ? "timeout" : "transport");
    } finally { reader.releaseLock(); }
    let reply: unknown;
    try { reply = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new EndpointFailure("malformed"); }
    if (!object(reply) || reply.jsonrpc !== "2.0" || reply.id !== request.id ||
      (Object.hasOwn(reply, "result") === Object.hasOwn(reply, "error"))) throw new EndpointFailure("malformed");
    if (Object.hasOwn(reply, "error")) {
      if (!object(reply.error) || typeof reply.error.code !== "number" || !Number.isSafeInteger(reply.error.code)) throw new EndpointFailure("malformed");
      if ([-32005, -32016].includes(reply.error.code)) throw new EndpointFailure("unhealthy");
      // Provider error text/data can echo credentials, headers or URLs. Preserve the
      // code, not arbitrary provider diagnostics; do not retry semantic errors.
      return { jsonrpc: "2.0", id: request.id, error: { code: reply.error.code, message: "RPC request rejected" } };
    }
    return { jsonrpc: "2.0", id: request.id, result: reply.result };
  }

  const poolFetch: FetchFn = async (_url, init) => {
    if (shutdown.signal.aborted) throw new RpcPoolError("closed");
    if (active >= 64) throw new RpcPoolError("capacity");
    if (typeof init?.body !== "string" || Buffer.byteLength(init.body) > 256 * 1024) throw new RpcPoolError("unsupported");
    // Copy once. Every retry includes identical signed bytes and send options.
    const body = init.body;
    let request: Request;
    try { request = JSON.parse(body); } catch { throw new RpcPoolError("unsupported"); }
    if (!object(request) || request.jsonrpc !== "2.0" || !["number", "string"].includes(typeof request.id) ||
      typeof request.method !== "string" || (request.params !== undefined && !Array.isArray(request.params)) ||
      !(/^(get[A-Z][A-Za-z]+|isBlockhashValid|simulateTransaction|sendTransaction)$/.test(request.method))) throw new RpcPoolError("unsupported");
    const config = request.params?.slice().reverse().find(object) ?? {};
    const requestLevel = request.method === "getSignatureStatuses" ? "processed" : level(config.commitment ?? config.preflightCommitment ?? commitment);
    const explicitFloor = config.minContextSlot ?? 0;
    if (!slotNumber(explicitFloor)) throw new RpcPoolError("unsupported");
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), requestMs);
    const signals = [shutdown.signal, budget.signal, confirmationScope.getStore(), init.signal as AbortSignal | undefined].filter((s): s is AbortSignal => !!s);
    const signal = AbortSignal.any(signals);
    active++;
    try {
      const order = endpoints.map((_, i) => (preferred + i) % endpoints.length);
      for (const index of order) {
        if (signal.aborted) break;
        const endpoint = endpoints[index]!;
        if (endpoint.quarantined || endpoint.retryAt > Date.now()) continue;
        const attempt = new AbortController();
        const attemptTimer = setTimeout(() => attempt.abort(), endpointMs);
        const attemptSignal = AbortSignal.any([signal, attempt.signal]);
        try {
          // Verify on each operation, including after an endpoint changes backend.
          const probe: Request = request.method === "getGenesisHash" ? request : { jsonrpc: "2.0", id: "genesis", method: "getGenesisHash" };
          const checked = await exchange(endpoint, probe, JSON.stringify(probe), attemptSignal);
          if (checked.error) throw new EndpointFailure("unhealthy");
          if (checked.result !== approvedGenesis) throw new EndpointFailure("genesis");
          const reply = request.method === "getGenesisHash" ? checked : await exchange(endpoint, request, body, attemptSignal);
          if (!reply.error) {
            const result = reply.result;
            const context = request.method === "getSlot" ? result : object(result) && object(result.context) ? result.context.slot : undefined;
            if (context !== undefined || contextual.has(request.method) || request.method === "getSlot") {
              if (!slotNumber(context)) throw new EndpointFailure("malformed");
              // Read the latest floor after I/O: a concurrent newer observation wins.
              if (context < Math.max(explicitFloor, floor(requestLevel))) throw new EndpointFailure("stale");
              floors[requestLevel] = context;
            }
          }
          preferred = index; endpoint.failures = 0; endpoint.reason = undefined; endpoint.retryAt = 0;
          return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
        } catch (e) {
          // A caller cancelling work is not evidence that the endpoint is sick.
          if (signal.aborted) {
            if (shutdown.signal.aborted) throw new RpcPoolError("closed");
            if (confirmationScope.getStore()?.aborted || init.signal?.aborted) throw new RpcPoolError("aborted");
            throw new RpcPoolError("unavailable");
          }
          endpoint.failures++;
          endpoint.reason = e instanceof EndpointFailure ? e.reason : "transport";
          endpoint.quarantined ||= endpoint.reason === "genesis";
          endpoint.retryAt = Date.now() + Math.min(10_000, 250 * 2 ** Math.min(endpoint.failures, 5));
        } finally { clearTimeout(attemptTimer); attempt.abort(); }
      }
      if (shutdown.signal.aborted) throw new RpcPoolError("closed");
      if (confirmationScope.getStore()?.aborted || init.signal?.aborted) throw new RpcPoolError("aborted");
      throw new RpcPoolError("unavailable");
    } finally { clearTimeout(timer); budget.abort(); active--; }
  };

  // The public endpoint is intentionally non-secret, including in web3 errors.
  const target = new Connection("https://ghostlink-rpc.invalid", { commitment, fetch: poolFetch, httpAgent: false, disableRetryOnRateLimit: true });
  async function confirm(strategy: TransactionConfirmationStrategy | string, requested?: Commitment) {
    if (typeof strategy !== "string" && (!("lastValidBlockHeight" in strategy) || !slotNumber(strategy.lastValidBlockHeight))) throw new RpcPoolError("unsupported");
    const signature = typeof strategy === "string" ? strategy : strategy.signature;
    try { if (bs58.decode(signature).length !== 64) throw new Error(); } catch { throw new RpcPoolError("unsupported"); }
    const desired = level(requested ?? commitment);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), confirmMs);
    const signal = AbortSignal.any([deadline.signal, shutdown.signal, ...(typeof strategy !== "string" && strategy.abortSignal ? [strategy.abortSignal] : [])]);
    try {
      return await confirmationScope.run(signal, async () => {
        while (!signal.aborted) {
          try {
            const statuses = await target.getSignatureStatuses([signature], { searchTransactionHistory: true });
            const status = statuses.value[0];
            if (status) {
              if (!slotNumber(status.slot) || status.slot > statuses.context.slot) throw new RpcPoolError("unavailable");
              const observed = status.confirmationStatus;
              if (observed === "finalized" || (desired === "confirmed" && observed === "confirmed") ||
                (desired === "processed" && ["processed", "confirmed"].includes(observed ?? ""))) {
                return { context: statuses.context, value: { err: status.err } };
              }
            } else if (typeof strategy !== "string" && "lastValidBlockHeight" in strategy &&
              await target.getBlockHeight({ commitment: "finalized", minContextSlot: floor("finalized") }) > strategy.lastValidBlockHeight) {
              // This is not evidence of an unsent/failed transaction. The durable
              // coordinator performs its independent finalized expiry checks.
              throw new RpcPoolError("confirmation-expired");
            }
          } catch (e) {
            if (!(e instanceof RpcPoolError) || e.code !== "unavailable") throw e;
          }
          await delay(pollMs, undefined, { signal });
        }
        throw new RpcPoolError("aborted");
      });
    } catch (e) {
      if (signal.aborted) throw new RpcPoolError(shutdown.signal.aborted ? "closed" : "aborted");
      throw e;
    } finally { clearTimeout(timer); deadline.abort(); }
  }
  const connection = new Proxy(target, {
    get(instance, property) {
      if (property === "confirmTransaction") return confirm;
      if (typeof property === "string" && (/^on[A-Z]/.test(property) || /^remove.*Listener$/.test(property))) {
        return () => { throw new RpcPoolError("unsupported"); };
      }
      const value = Reflect.get(instance, property);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
  return {
    connection,
    close: () => shutdown.abort(),
    status: () => ({ active, closed: shutdown.signal.aborted, preferred, floors: { ...floors },
      endpoints: endpoints.map((e, index) => ({ index, failures: e.failures, reason: e.reason,
        state: e.quarantined ? "quarantined" : e.retryAt > Date.now() ? "cooldown" : "available" })) }),
  };
}
