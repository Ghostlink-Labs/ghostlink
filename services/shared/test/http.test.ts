/** The HTTP kit's hardening: bounded bodies, preflight, status mapping. */
import { describe, expect, it } from "vitest";
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
