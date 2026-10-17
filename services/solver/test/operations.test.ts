import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Keypair, type Connection } from "@solana/web3.js";
import { POCKET_PROGRAM_ID } from "@ghostlink/common";
import { createRpcPool } from "@ghostlink/service-kit/rpc";
import { SolverOperations, operatorServer } from "../src/operations.js";
import { buildServer, MockPlanner } from "../src/server.js";
import { SubmissionJournal } from "../src/journal.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  let now = 0, slot = 10, lamports = 10_000_000, storage = true;
  const genesis = Keypair.generate().publicKey.toBase58(), solver = Keypair.generate();
  const connection = {
    getGenesisHash: vi.fn(async () => genesis),
    getBalanceAndContext: vi.fn(async () => ({ context: { slot }, value: lamports })),
  };
  const operations = new SolverOperations({ connection, solver: solver.publicKey, genesisHash: genesis, minimumBalanceLamports: 5_000_000,
    checkWritable: () => { if (!storage) throw new Error("private path"); }, clock: () => now,
    probeTimeoutMs: 25, freshnessMs: 100, progressTimeoutMs: 200, maxInFlight: 2 });
  cleanups.push(() => operations.stop());
  return { operations, connection, solver, genesis, advance: (elapsed = 1) => { now += elapsed; slot++; },
    time: (elapsed: number) => { now += elapsed; }, balance: (value: number) => { lamports = value; }, storage: (value: boolean) => { storage = value; } };
}
async function ready(f: ReturnType<typeof fixture>) { await f.operations.refresh(); f.advance(); await f.operations.refresh(); }

describe("solver admission evidence", () => {
  it("requires actual progress, fresh chain evidence, fee reserve and writable storage; statuses survive refusal", async () => {
    const f = fixture();
    expect(f.operations.acquire("intent")).toBeUndefined();
    await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(false);
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.balance(1); await f.operations.refresh(); expect(f.operations.acquire("intent")).toBeUndefined();
    const status = f.operations.acquire("status"); expect(status).toBeTypeOf("function"); status!();
    f.balance(10_000_000); f.storage(false); await f.operations.refresh(); expect(f.operations.snapshot().checks.storage).toBe(false);
    f.storage(true); f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.time(101); expect(f.operations.snapshot().checks.fresh).toBe(false);
    await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.time(100); await f.operations.refresh(); expect(f.operations.snapshot().checks.chainProgress).toBe(false);
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.connection.getGenesisHash.mockResolvedValueOnce("wrong-chain");
    await f.operations.refresh(); expect(f.operations.snapshot().checks.rpc).toBe(false);
  });

  it("does not pile up hung probes or accept a late success after timeout", async () => {
    const f = fixture(); await ready(f);
    let release!: (value: { context: { slot: number }; value: number }) => void;
    f.connection.getBalanceAndContext.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.connection.getGenesisHash.mockRejectedValueOnce(new Error("provider secret"));
    const calls = f.connection.getBalanceAndContext.mock.calls.length;
    const first = f.operations.refresh();
    await Promise.all(Array.from({ length: 50 }, () => f.operations.refresh()));
    await first;
    expect(f.operations.snapshot().ready).toBe(false);
    expect(f.operations.snapshot().probing).toBe(true);
    await f.operations.refresh();
    expect(f.connection.getBalanceAndContext).toHaveBeenCalledTimes(calls + 1);
    release({ context: { slot: 100 }, value: 10_000_000 });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.operations.snapshot().ready).toBe(false);
    expect(f.operations.snapshot().probing).toBe(false);
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
  });

  it("bounds active work, keeps drain irrevocable, and exposes only bounded metrics", async () => {
    const f = fixture(); await ready(f);
    const releases = [f.operations.acquire("intent"), f.operations.acquire("status")];
    for (let i = 0; i < 1000; i++) expect(f.operations.acquire("intent")).toBeUndefined();
    expect(f.operations.snapshot().active).toBe(2);
    releases[0]!(); releases[0]!(); expect(f.operations.snapshot().active).toBe(1);
    f.operations.drain(); releases[1]!();
    f.advance(); await f.operations.refresh(); expect(f.operations.acquire("intent")).toBeUndefined();
    const release = f.operations.acquire("status"); expect(release).toBeTypeOf("function"); release!();
    const rpc = createRpcPool({ genesisHash: f.genesis, endpoints: [{ url: "https://example.invalid/?key=private-test-value" }] });
    cleanups.push(() => rpc.close());
    const server = operatorServer(f.operations, rpc.status); server.listen(0, "127.0.0.1"); await once(server, "listening");
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    const text = await (await fetch(`http://127.0.0.1:${address.port}/metrics`)).text();
    expect(text).toContain('ghostlink_solver_requests_total{kind="intent",outcome="rejected"} 1001');
    expect(text).toContain("ghostlink_solver_ready 0");
    expect(text).not.toContain(f.solver.publicKey.toBase58());
    expect(text).not.toContain("private-test-value");
    expect(text).toContain('ghostlink_rpc_available{provider="0"} 1');
    expect(text.length).toBeLessThan(2048);
  });

  it("serves cached HTTP readiness and gates new intents without running probes per poll", async () => {
    const f = fixture(), dir = mkdtempSync(join(tmpdir(), "ghostlink-ops-http-")), key = randomBytes(32);
    const journal = new SubmissionJournal(join(dir, "journal.sqlite"), key,
      { genesisHash: f.genesis, solver: f.solver.publicKey.toBase58(), pocketProgram: POCKET_PROGRAM_ID });
    cleanups.push(() => { journal.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); });
    const server = buildServer({ connection: f.connection as unknown as Connection, journal, keypair: f.solver, planner: new MockPlanner(), priceAccounts: {} });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    const base = `http://127.0.0.1:${address.port}`;
    await server.operations.refresh();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    expect((await fetch(`${base}/intent`, { method: "POST", body: "{}" })).status).toBe(503);
    f.advance(); await server.operations.refresh();
    const calls = f.connection.getBalanceAndContext.mock.calls.length;
    const polls = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/ready`)));
    expect(polls.every(p => p.status === 200 && p.headers.get("cache-control") === "no-store")).toBe(true);
    expect(f.connection.getBalanceAndContext).toHaveBeenCalledTimes(calls);
    expect((await fetch(`${base}/intent`, { method: "POST", body: "{}" })).status).toBe(400);
    journal.close(); await server.operations.refresh();
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    expect((await fetch(`${base}/intent`, { method: "POST", body: "{}" })).status).toBe(503);
  });
});
