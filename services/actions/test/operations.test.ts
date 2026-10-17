import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { Keypair } from "@solana/web3.js";
import { createRpcPool } from "@ghostlink/service-kit/rpc";
import { ActionsOperations, operatorServer } from "../src/operations.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  let now = 0, slot = 10;
  const genesisHash = Keypair.generate().publicKey.toBase58();
  const connection = { getGenesisHash: vi.fn(async () => genesisHash), getSlot: vi.fn(async () => slot) };
  const operations = new ActionsOperations({ connection, genesisHash, clock: () => now,
    probeTimeoutMs: 25, freshnessMs: 100, progressTimeoutMs: 200, maxInFlight: 2 });
  cleanup.push(() => operations.stop());
  return { operations, connection, genesisHash, advance: (elapsed = 1) => { slot++; now += elapsed; }, time: (elapsed: number) => { now += elapsed; } };
}
async function ready(f: ReturnType<typeof fixture>) { await f.operations.refresh(); f.advance(); await f.operations.refresh(); }

describe("Actions readiness", () => {
  it("requires fresh advancing chain evidence, refuses wrong/stale/frozen contexts and recovers", async () => {
    const f = fixture(); await f.operations.refresh(); expect(f.operations.acquire()).toBeUndefined();
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.time(101); expect(f.operations.snapshot().ready).toBe(false);
    await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.time(100); await f.operations.refresh(); expect(f.operations.snapshot().checks.chainProgress).toBe(false);
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.connection.getGenesisHash.mockResolvedValueOnce("wrong-chain"); await f.operations.refresh();
    expect(f.operations.snapshot().checks.rpc).toBe(false);
    f.connection.getSlot.mockResolvedValueOnce(1); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(false);
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
  });
  it("bounds hung and synchronously failing probes; late success cannot enable admission", async () => {
    const f = fixture(); await ready(f);
    let release!: (slot: number) => void;
    f.connection.getSlot.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const calls = f.connection.getSlot.mock.calls.length;
    await Promise.all(Array.from({ length: 40 }, () => f.operations.refresh()));
    expect(f.operations.snapshot().ready).toBe(false); expect(f.operations.idle).toBe(false);
    await f.operations.refresh(); expect(f.connection.getSlot).toHaveBeenCalledTimes(calls + 1);
    release(100); await new Promise(resolve => setImmediate(resolve));
    expect(f.operations.minimumSlot).toBe(11); expect(f.operations.snapshot().ready).toBe(false);
    f.connection.getSlot.mockImplementationOnce(() => { throw new Error("private provider diagnostic"); });
    await f.operations.refresh(); expect(f.operations.idle).toBe(true);
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
  });
  it("refuses overload, drains admitted work and probes, and keeps metrics bounded and private", async () => {
    const f = fixture(); await ready(f);
    const one = f.operations.acquire(), two = f.operations.acquire();
    for (let i = 0; i < 1000; i++) expect(f.operations.acquire()).toBeUndefined();
    let finish!: (slot: number) => void;
    f.connection.getSlot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const probe = f.operations.refresh(); await new Promise(resolve => setImmediate(resolve));
    f.operations.drain(); expect(f.operations.idle).toBe(false);
    expect(() => f.operations.assertFresh()).not.toThrow();
    one!(); one!(); two!(); expect(f.operations.idle).toBe(false);
    finish(12); await probe; expect(f.operations.idle).toBe(true); expect(f.operations.acquire()).toBeUndefined();
    const pool = createRpcPool({ genesisHash: f.genesisHash, endpoints: [{ url: "https://example.invalid/?secret=PRIVATE_URL_MARKER" }] });
    cleanup.push(() => pool.close());
    const server = operatorServer(f.operations, pool.status); server.listen(0, "127.0.0.1"); await once(server, "listening");
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    const metrics = await (await fetch(`http://127.0.0.1:${address.port}/metrics`)).text();
    expect(metrics).toContain('ghostlink_actions_requests_total{outcome="rejected"} 1001');
    expect(metrics).toContain("ghostlink_actions_ready 0"); expect(metrics).not.toContain("PRIVATE_URL_MARKER");
    expect(metrics).not.toContain(f.genesisHash); expect(metrics.length).toBeLessThan(1800);
  });
});
