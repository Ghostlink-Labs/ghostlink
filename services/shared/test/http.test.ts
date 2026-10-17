/** The HTTP kit's hardening: bounded bodies, preflight, status mapping. */
import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { request } from "node:http";
import { HttpError, RateLimiter, Router, Semaphore, badRequest } from "../src/index.js";

async function withRouter<T>(router: Router, fn: (base: string) => Promise<T>): Promise<T> {
  const server = router.server();
  server.listen(0);
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe("router", () => {
  it.each(["development", "production"])("keeps unexpected errors and request values private by default in %s", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const marker = "SYNTHETIC_PROVIDER_AND_REQUEST_SECRET";
    try {
      const guarded = new Router();
      guarded.get("/rpc/:value", async () => { throw new Error(`provider https://example.invalid/${marker}?api-key=${marker}`); });
      await withRouter(guarded, async (base) => {
        const response = await fetch(`${base}/rpc/${marker}?token=${marker}`, { headers: { authorization: marker } });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal error" });
        expect(log).toHaveBeenCalled();
        expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
      });
    } finally { log.mockRestore(); vi.unstubAllEnvs(); }
  });

  it("bounds bodies before parsing and retains capacity until disconnected work actually finishes", async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const router = new Router({ maxInFlight: 1 });
    router.post("/body", async () => ({ json: { ok: true } }));
    router.get("/hold", async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { json: {} }; });
    router.get("/ok", async () => ({ json: {} }));
    const server = router.server(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    const url = `http://127.0.0.1:${address.port}`;
    const incoming = once(server, "request");
    const slow = request(`${url}/body`, { method: "POST", headers: { "content-length": "100" } });
    slow.on("error", () => {}); slow.flushHeaders();
    const [raw] = await incoming;
    try {
      expect((await fetch(`${url}/ok`)).status).toBe(503);
      const closed = new Promise<void>(resolve => raw.once("close", resolve)); slow.destroy(); await closed;
      await new Promise(resolve => setImmediate(resolve));
      const controller = new AbortController();
      const held = fetch(`${url}/hold`, { signal: controller.signal }).catch(() => {});
      await started; controller.abort(); await held;
      expect((await fetch(`${url}/ok`)).status).toBe(503);
      release(); await new Promise(resolve => setImmediate(resolve));
      expect((await fetch(`${url}/ok`)).status).toBe(200);
    } finally { slow.destroy(); release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  const router = new Router({ maxBodyBytes: 1024, exposeErrors: false, onError: () => undefined });
  router.post("/echo", async ({ body }) => ({ json: { body } }));
  router.get("/boom", async () => {
    throw new Error("secret internals");
  });
  router.get("/teapot", async () => {
    throw new HttpError(418, "short and stout");
  });
  router.get("/bad", async () => {
    throw badRequest("nope");
  });
  router.get("/item/:id", async ({ params }) => ({ json: { id: params.id } }));

  it("rejects oversized and malformed bodies with 4xx", async () => {
    await withRouter(router, async (base) => {
      const big = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(2048) }),
      });
      expect(big.status).toBe(413);
      const bad = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(await ok.json()).toEqual({ body: { a: 1 } });
    });
  });

  it("answers preflight for any registered path and maps errors to statuses", async () => {
    await withRouter(router, async (base) => {
      const pre = await fetch(`${base}/echo`, { method: "OPTIONS" });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-headers")).toContain("content-type");
      expect((await fetch(`${base}/nowhere`, { method: "OPTIONS" })).status).toBe(404);

      const boom = await fetch(`${base}/boom`);
      expect(boom.status).toBe(500);
      expect(await boom.json()).toEqual({ error: "internal error" });
      expect((await fetch(`${base}/teapot`)).status).toBe(418);
      expect((await fetch(`${base}/bad`)).status).toBe(400);
      expect((await fetch(`${base}/item/%E0%A4%A`)).status).toBe(400);
      expect((await fetch(`${base}/item/abc`, { method: "HEAD" })).status).toBe(200);
    });
  });

  it("returns 413 for an oversized chunked body before closing the connection", async () => {
    await withRouter(router, async (base) => {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${base}/echo`, { method: "POST", headers: { "transfer-encoding": "chunked" } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.write("x".repeat(2048));
        req.end();
      });
      expect(status).toBe(413);
    });
  });
});

describe("rate limiter and semaphore", () => {
  it("refuses new identities at capacity without evicting existing rate limits", () => {
    const limiter = new RateLimiter(2, 1000, 2);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("b", 1)).toBe(true);
    expect(limiter.allow("c", 2)).toBe(false);
    expect(limiter.allow("a", 3)).toBe(true);
    expect(limiter.allow("a", 4)).toBe(false);
    expect(limiter.allow("c", 1000)).toBe(true);
    expect(limiter.allow("x".repeat(257), 1001)).toBe(false);
  });

  it("rejects excess queued work without executing it", async () => {
    const sem = new Semaphore(1, 1);
    let release!: () => void, ran = false;
    const active = sem.run(() => new Promise<void>(resolve => { release = resolve; }));
    const waiting = sem.run(async () => {});
    try { await expect(sem.run(async () => { ran = true; })).rejects.toThrow("busy"); }
    finally { release(); await Promise.all([active, waiting]); }
    expect(ran).toBe(false);
  });
  it("limits per key per window and forgets old windows", () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 1)).toBe(true);
    expect(limiter.allow("a", 2)).toBe(false);
    expect(limiter.allow("b", 2)).toBe(true);
    expect(limiter.allow("a", 1001)).toBe(true);
  });

  it("runs at most N jobs at once", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("reserves a released slot for a queued job before a new arrival can take it", async () => {
    const sem = new Semaphore(1);
    let release!: () => void;
    let active = 0;
    let peak = 0;
    const first = sem.run(async () => {});
    const second = sem.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { release = resolve; });
      active -= 1;
    });
    // The first job releases in the preceding microtask; the queued job's
    // continuation is still behind this arrival.
    await Promise.resolve();
    const third = sem.run(async () => { active += 1; peak = Math.max(peak, active); active -= 1; });
    await first;
    release();
    await Promise.all([second, third]);
    expect(peak).toBe(1);
  });
});
