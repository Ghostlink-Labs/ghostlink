import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@solana/web3.js";
import { POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import { createRpcPool } from "@ghostlink/service-kit/rpc";
import { RelayerOperations, operatorServer } from "../src/operations.js";
import { RelayerJournal } from "../src/journal.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  let now = 0, slot = 10, lamports = 100_000_000;
  const genesis = Keypair.generate().publicKey.toBase58(), payer = Keypair.generate();
  const dir = mkdtempSync(join(tmpdir(), "relayer-ops-")), path = join(dir, "journal.db");
  const journal = new RelayerJournal(path, randomBytes(32), { genesisHash: genesis, payer: payer.publicKey.toBase58(),
    pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() });
  cleanups.push(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const connection = {
    getGenesisHash: vi.fn(async () => genesis),
    getBalanceAndContext: vi.fn(async () => ({ context: { slot }, value: lamports })),
  };
  const reconcile = vi.fn(async (_ids: string[]) => {});
  const operations = new RelayerOperations({ connection, payer: payer.publicKey, genesisHash: genesis, journal, reconcile,
    minimumBalanceLamports: 50_000_000, clock: () => now, probeTimeoutMs: 25, freshnessMs: 100, progressTimeoutMs: 200, maxInFlight: 2 });
  cleanups.push(() => operations.stop());
  return { operations, connection, reconcile, journal, path, payer, genesis,
    advance: (elapsed = 1) => { now += elapsed; slot++; }, time: (elapsed: number) => { now += elapsed; }, balance: (value: number) => { lamports = value; } };
}
async function ready(f: ReturnType<typeof fixture>) { await f.operations.refresh(); f.advance(); await f.operations.refresh(); }

describe("relayer admission evidence", () => {
  it("reconciles a bounded round-robin batch and retains probe ownership throughout drain", async () => {
    const f = fixture();
    const ids = Array.from({ length: 9 }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
    for (const id of ids) {
      const claim = f.journal.claim(id, id);
      f.journal.prepare(id, claim.token!, { rawBase64: "AA==", signature: id, blockhash: f.genesis,
        lastValidBlockHeight: 100, minContextSlot: 10, feeLamports: "100", rentLamports: "0" },
        { balanceLamports: 100_000_000n, slot: 10, minimumReserveLamports: 50_000_000n });
    }
    f.reconcile.mockImplementation(async batch => {
      for (const id of batch) f.journal.observe(id, { requestIdHex: id, signature: id, state: "finalized", confirmationStatus: "finalized", slot: 10 }, 10);
    });
    await f.operations.refresh(); f.advance(); await f.operations.refresh(); await f.operations.refresh();
    expect(f.reconcile.mock.calls.map(([batch]) => batch.length)).toEqual([4, 4, 1]);
    expect(f.reconcile.mock.calls.flatMap(([batch]) => batch)).toEqual(ids);
    expect(f.operations.snapshot()).toMatchObject({ ready: true, unsettledLamports: "0", spentLamports24h: "900" });
    let release!: () => void;
    f.reconcile.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const probe = f.operations.refresh(); await new Promise(resolve => setImmediate(resolve));
    f.operations.drain(); expect(f.operations.idle).toBe(false);
    release(); await probe; expect(f.operations.idle).toBe(true);
    expect(f.operations.snapshot().ready).toBe(false);
  });
  it("requires fresh advancing chain evidence, payer reserve and actual writable authenticated storage", async () => {
    const f = fixture();
    await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(false);
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.balance(1); await f.operations.refresh(); expect(f.operations.snapshot().checks.feeReserve).toBe(false);
    const status = f.operations.acquire("reconcile"); expect(status).toBeTypeOf("function"); status!();
    f.balance(100_000_000); f.time(101); expect(f.operations.snapshot().checks.fresh).toBe(false);
    await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.time(100); await f.operations.refresh(); expect(f.operations.snapshot().checks.chainProgress).toBe(false);
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.connection.getGenesisHash.mockResolvedValueOnce("wrong-chain");
    await f.operations.refresh(); expect(f.operations.snapshot().checks.rpc).toBe(false);
    const fault = new DatabaseSync(f.path); cleanups.push(() => fault.close());
    fault.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    await f.operations.refresh(); expect(f.operations.snapshot().checks.storage).toBe(false);
    fault.exec("ROLLBACK");
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
    f.connection.getBalanceAndContext.mockResolvedValueOnce({ context: { slot: 1 }, value: 100_000_000 });
    await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(false);
  });

  it("does not pile up hung probes or accept late success after timeout", async () => {
    const f = fixture(); await ready(f);
    let release!: (value: { context: { slot: number }; value: number }) => void;
    f.connection.getBalanceAndContext.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const calls = f.connection.getBalanceAndContext.mock.calls.length;
    await Promise.all(Array.from({ length: 50 }, () => f.operations.refresh()));
    expect(f.operations.snapshot().ready).toBe(false); expect(f.operations.idle).toBe(false);
    await f.operations.refresh(); expect(f.connection.getBalanceAndContext).toHaveBeenCalledTimes(calls + 1);
    release({ context: { slot: 100 }, value: 100_000_000 });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.operations.snapshot().ready).toBe(false); expect(f.operations.idle).toBe(true);
    f.advance(); await f.operations.refresh(); expect(f.operations.snapshot().ready).toBe(true);
  });

  it("reserves a reconciliation slot under saturation, drains irreversibly and keeps metrics private", async () => {
    const f = fixture(); await ready(f);
    const first = f.operations.acquire("new"); expect(first).toBeTypeOf("function");
    for (let i = 0; i < 1000; i++) expect(f.operations.acquire("new")).toBeUndefined();
    const status = f.operations.acquire("reconcile"); expect(status).toBeTypeOf("function");
    expect(f.operations.acquire("reconcile")).toBeUndefined();
    f.operations.drain(); first!(); first!(); status!();
    f.advance(); await f.operations.refresh(); expect(f.operations.acquire("new")).toBeUndefined();
    expect(f.operations.idle).toBe(true);
    const rpc = createRpcPool({ genesisHash: f.genesis, endpoints: [{ url: "https://example.invalid/?key=private-test-value" }] });
    cleanups.push(() => rpc.close());
    const server = operatorServer(f.operations, rpc.status); server.listen(0, "127.0.0.1"); await once(server, "listening");
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    const text = await (await fetch(`http://127.0.0.1:${address.port}/metrics`)).text();
    expect(text).toContain('ghostlink_relayer_requests_total{kind="new",outcome="rejected"} 1001');
    expect(text).toContain("ghostlink_relayer_ready 0");
    for (const secret of [f.payer.publicKey.toBase58(), "private-test-value", f.path]) expect(text).not.toContain(secret);
    expect(text).toContain('ghostlink_rpc_available{provider="0"} 1'); expect(text.length).toBeLessThan(2400);
  });
});
