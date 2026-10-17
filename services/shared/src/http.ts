/**
 * A tiny HTTP router over node:http — no framework, no magic.
 *
 * Hardening that every service inherits: bounded request bodies, generic
 * CORS preflight (browser apps call the relayer and solver directly),
 * 4xx for client mistakes, opaque 5xx for everything else, and server
 * timeouts so slow clients cannot pin connections.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

export type Handler = (req: {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  raw: IncomingMessage;
}) => Promise<{ status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>;

/** Throw from a handler to answer with a specific status and message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string) => new HttpError(400, message);

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export interface RouterOptions {
  /** Largest accepted request body; default 64 KiB. */
  maxBodyBytes?: number;
  /** Includes requests still reading a body and handlers whose client disconnected. */
  maxInFlight?: number;
  /** Bound idle/slow connections as well as dispatched requests. */
  maxConnections?: number;
  /** `access-control-allow-origin`; default "*" (public read APIs). */
  allowOrigin?: string;
  /** Include thrown error messages in 500 responses (default: outside production). */
  exposeErrors?: boolean;
  /** Called for every unexpected (non-HttpError) failure. */
  onError?: (error: unknown, req: IncomingMessage) => void;
}

export class Router {
  private routes: Route[] = [];
  private readonly maxBodyBytes: number;
  private readonly allowOrigin: string;
  private readonly exposeErrors: boolean;
  private readonly onError: (error: unknown, req: IncomingMessage) => void;
  private readonly maxInFlight: number;
  private readonly maxConnections: number;

  constructor(options: RouterOptions = {}) {
    this.maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
    this.maxInFlight = options.maxInFlight ?? 64;
    this.maxConnections = options.maxConnections ?? 512;
    for (const n of [this.maxBodyBytes, this.maxInFlight, this.maxConnections]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("HTTP limits must be positive integers");
    }
    this.allowOrigin = options.allowOrigin ?? "*";
    this.exposeErrors = options.exposeErrors ?? process.env.NODE_ENV !== "production";
    this.onError =
      options.onError ??
      ((e, req) => console.error(`${req.method} ${req.url} failed:`, e instanceof Error ? e.message : e));
  }

  get(path: string, handler: Handler): this {
    return this.add("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add("POST", path, handler);
  }

  options(path: string, handler: Handler): this {
    return this.add("OPTIONS", path, handler);
  }

  private add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
    return this;
  }

  private corsHeaders(): Record<string, string> {
    return {
      "access-control-allow-origin": this.allowOrigin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers":
        "content-type,authorization,accept-encoding,x-action-version,x-blockchain-ids,x-accept-action-version,x-accept-blockchain-ids",
      "access-control-max-age": "86400",
    };
  }

  server(): Server {
    let active = 0;
    const server = createServer((req, res) => {
      if (active >= this.maxInFlight) {
        res.once("finish", () => req.destroy());
        send(res, 503, { error: "service busy; retry the same request" },
          { ...this.corsHeaders(), connection: "close", "retry-after": "1" }, req.method === "HEAD");
        return;
      }
      active++;
      this.dispatch(req, res).catch((e) => {
        if (res.destroyed || res.writableEnded) return;
        if (e instanceof HttpError) {
          if (e.status === 413) {
            res.setHeader("connection", "close");
            res.once("finish", () => req.destroy());
          }
          send(res, e.status, { error: e.message }, this.corsHeaders());
          return;
        }
        this.onError(e, req);
        send(
          res,
          500,
          { error: this.exposeErrors ? (e instanceof Error ? e.message : String(e)) : "internal error" },
          this.corsHeaders(),
        );
      }).finally(() => { active--; });
    });
    // Slow-client protection; JSON APIs never need long-lived requests.
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.maxConnections = this.maxConnections;
    return server;
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    const cors = this.corsHeaders();

    let preflightMatch = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const want = route.parts[i]!;
        if (want.startsWith(":")) {
          try {
            params[want.slice(1)] = decodeURIComponent(parts[i]!);
          } catch {
            throw badRequest("malformed path");
          }
        } else if (want !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        if (method === "OPTIONS") preflightMatch = true;
        continue;
      }
      const body = method === "POST" ? await this.readJson(req) : undefined;
      const out = await route.handler({ params, query: url.searchParams, body, raw: req });
      const headers = { ...cors, ...out.headers };
      if (out.text !== undefined) {
        res.writeHead(out.status ?? 200, { "content-type": "text/plain", ...headers });
        res.end(req.method === "HEAD" ? undefined : out.text);
      } else {
        send(res, out.status ?? 200, out.json ?? {}, headers, req.method === "HEAD");
      }
      return;
    }
    if (method === "OPTIONS" && preflightMatch) {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    send(res, 404, { error: "not found" }, cors);
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > this.maxBodyBytes) throw new HttpError(413, "request body too large");
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const cleanup = () => {
        req.off("data", data);
        req.off("end", end);
        req.off("error", fail);
        req.off("aborted", aborted);
      };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const aborted = () => fail(badRequest("request aborted"));
      const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
      const data = (chunk: Buffer) => {
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          req.pause();
          fail(new HttpError(413, "request body too large"));
        } else chunks.push(chunk);
      };
      req.on("data", data).once("end", end).once("error", fail).once("aborted", aborted);
    });
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw badRequest("invalid JSON body");
    }
  }
}

function send(
  res: ServerResponse,
  status: number,
  json: unknown,
  headers: Record<string, string> = {},
  headOnly = false,
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(headOnly ? undefined : JSON.stringify(json, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 * In-memory fixed-window limiter. Never evict an unexpired quota to admit a
 * new identity; reject new keys when full. Expiry order bounds cleanup work.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();
  private latestTime = -Infinity;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {
    for (const value of [max, windowMs, maxKeys]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("rate limits must be positive integers");
    }
  }

  allow(key: string, now = Date.now()): boolean {
    if (key.length > 256 || !Number.isFinite(now)) return false;
    now = this.latestTime = Math.max(now, this.latestTime);
    // Entries are inserted in window-start order; hits don't reorder them.
    for (const [oldKey, entry] of this.hits) {
      if (now - entry.windowStart < this.windowMs) break;
      this.hits.delete(oldKey);
    }
    const entry = this.hits.get(key);
    if (!entry) {
      if (this.hits.size >= this.maxKeys) return false;
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count = Math.min(this.max + 1, entry.count + 1);
    return entry.count <= this.max;
  }

}

/**
 * The caller's address for rate limiting. Only honours X-Forwarded-For
 * when the deployment says a trusted proxy sets it; otherwise anyone
 * could pick their own bucket.
 */
export function clientIp(req: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Limits how many of something run at once (e.g. transactions in flight). */
export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly limit: number, private readonly maxQueued = 64) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("concurrency must be a positive integer");
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) throw new RangeError("queue capacity must be a nonnegative integer");
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxQueued) throw new HttpError(503, "service busy; retry later");
      await new Promise<void>((r) => this.waiting.push(r));
    }
    else this.active += 1;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the occupied slot directly to the next waiter
      else this.active -= 1;
    }
  }
}
