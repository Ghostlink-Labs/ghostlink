import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { Connection } from "@solana/web3.js";
import { REGISTRY, CENSUS } from "@ghostlink/service-kit";
import { IndexerDatabase } from "../src/database.js";
import { IndexerStore } from "../src/store.js";
import { Poller } from "../src/poller.js";
import { buildServer } from "../src/server.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.reverse()) f(); cleanup.length = 0; });
const info = (signature: string, slot = 1) => ({ signature, slot, err: null, memo: null, blockTime: 0 });
function world() {
  const dir = mkdtempSync(join(tmpdir(), "indexer-backfill-")), path = join(dir, "indexer.db"), key = randomBytes(32);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now(); const scope = "synthetic finalized indexer";
  const open = () => { const db = new IndexerDatabase(path, key, scope, () => now); cleanup.push(() => db.close()); return db; };
  const getTransaction = vi.fn(async (signature: string) => ({ slot: 1, transaction: { signatures: [signature] }, meta: { err: null, logMessages: [] } }));
  return { dir, path, key, scope, open, advance: () => { now += 120_000; }, getTransaction };
}
const config = (database: IndexerDatabase) => ({ database, maximumPages: 1, maximumTransactions: 1, paceMs: 0 });

describe("durable bounded indexer backfill", () => {
  it("resumes saved pagination after restart and preserves cross-program same-slot order across batches", async () => {
    const w = world(); let db = w.open(), store = new IndexerStore();
    const reads: string[] = [];
    const chain = { getSlot: vi.fn(async () => 1), getTransaction: w.getTransaction,
      getSignaturesForAddress: vi.fn(async (program, options) => {
        reads.push(`${program.equals(REGISTRY) ? 'r' : 'c'}:${options.before ?? 'head'}`);
        if (program.equals(REGISTRY)) return options.before ? [info("A")] : [info("C"), info("B")];
        return options.before ? [] : [info("D"), info("C")];
      }) };
    let poller = new Poller(chain as unknown as Connection, store, [REGISTRY, CENSUS], 2, "finalized", config(db));
    await poller.tick(); expect(w.getTransaction).not.toHaveBeenCalled(); db.close();
    db = w.open(); store = new IndexerStore(); poller = new Poller(chain as unknown as Connection, store, [REGISTRY, CENSUS], 2, "finalized", config(db));
    for (let n = 0; n < 7 && poller.status.catchingUp; n++) await poller.tick();
    expect(reads).toEqual(["r:head", "r:B", "c:head", "c:C"]);
    expect(w.getTransaction.mock.calls.map(c => c[0])).toEqual(["A", "B", "C", "D"]);
    expect(store.cursors.get(REGISTRY.toBase58())).toBe("C"); expect(store.cursors.get(CENSUS.toBase58())).toBe("D");
    expect(poller.status.catchingUp).toBe(false); expect(db.pending()).toBe(0); expect(db.through()).toBe(1);
  });
  it("bounds each tick while resuming a longer history and excludes transactions above the captured head", async () => {
    const w = world(); let db = w.open(), store = new IndexerStore(); store.setCursor(REGISTRY.toBase58(), "A0");
    const history = Array.from({ length: 76 }, (_, n) => info(`A${75-n}`, 75-n));
    const chain = { getSlot: vi.fn(async () => 60),
      getSignaturesForAddress: vi.fn(async (_program, options) => { const from = options.before ? history.findIndex(i => i.signature === options.before) + 1 : 0; return history.slice(from, from + options.limit); }),
      getTransaction: vi.fn(async (signature: string) => ({ slot: Number(signature.slice(1)), transaction: { signatures: [signature] }, meta: { err: null, logMessages: [] } })) };
    const build = () => new Poller(chain as unknown as Connection, store, [REGISTRY], 5, "finalized", { database: db, maximumPages: 2, maximumTransactions: 3, paceMs: 0 });
    let poller = build(); await poller.tick(); expect(chain.getTransaction).not.toHaveBeenCalled();
    db.close(); db = w.open(); store = new IndexerStore(); poller = build();
    for (let tick = 0; tick < 40 && poller.status.catchingUp; tick++) {
      const pages = chain.getSignaturesForAddress.mock.calls.length, transactions = chain.getTransaction.mock.calls.length;
      await poller.tick();
      expect(chain.getSignaturesForAddress.mock.calls.length - pages).toBeLessThanOrEqual(2);
      expect(chain.getTransaction.mock.calls.length - transactions).toBeLessThanOrEqual(3);
    }
    expect(poller.status.catchingUp).toBe(false); expect(chain.getSlot).toHaveBeenCalledOnce();
    expect(chain.getTransaction.mock.calls.map(c => c[0])).toEqual(Array.from({ length: 60 }, (_, n) => `A${n+1}`));
    expect(store.cursors.get(REGISTRY.toBase58())).toBe("A60"); expect(db.through()).toBe(60);
  });

  it("rolls back state, cursor and dequeue together on SQLite failure and on a partial event failure", async () => {
    const w = world(), db = w.open(), store = new IndexerStore(); db.save(store.snapshot());
    db.begin(1, [REGISTRY.toBase58()], store.cursors); db.page(REGISTRY.toBase58(), undefined, [info("A")], 2);
    const opened = { kind: "SessionOpened" as const, pocket: "pocket", appId: new Uint8Array(32), created: true, sessionExpirySlot: 10n };
    const fault = new DatabaseSync(w.path); cleanup.push(() => fault.close());
    fault.exec("CREATE TRIGGER disk_failure BEFORE DELETE ON pending BEGIN SELECT RAISE(ABORT,'disk full'); END");
    expect(() => store.checkpointTransaction("A", [opened], [REGISTRY.toBase58()], s => db.complete("A", s))).toThrow();
    expect(store.pockets.size).toBe(0); expect(store.cursors.size).toBe(0); expect(db.pending()).toBe(1); expect(db.snapshot()!.pockets).toEqual({});
    fault.exec("DROP TRIGGER disk_failure");
    const invalid = { kind: "Registered" as const, wallet: "wallet", commitment: new Uint8Array(32), leafIndex: 2n, leaf: new Uint8Array(32), root: new Uint8Array(32) };
    expect(() => store.checkpointTransaction("A", [opened, invalid], [REGISTRY.toBase58()], s => db.complete("A", s))).toThrow(/gap/);
    expect(store.pockets.size).toBe(0); expect(store.activity).toEqual([]); expect(db.pending()).toBe(1);
    store.checkpointTransaction("A", [opened], [REGISTRY.toBase58()], s => db.complete("A", s));
    expect(db.snapshot()!.cursors![REGISTRY.toBase58()]).toBe("A"); expect(db.pending()).toBe(0);
  });
  it("recovers an atomic checkpoint after abrupt child exit and fences the old worker", () => {
    const w = world(), fixture = join(w.dir, "fixture.json");
    writeFileSync(fixture, JSON.stringify({ key: w.key.toString("hex"), scope: w.scope, program: REGISTRY.toBase58(), snapshot: new IndexerStore().snapshot() }));
    const module = pathToFileURL(join(process.cwd(), "dist/database.js")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {readFileSync} from 'node:fs'; import {IndexerDatabase} from ${JSON.stringify(module)};
      const f=JSON.parse(readFileSync(process.argv[1])); const db=new IndexerDatabase(process.argv[2],Buffer.from(f.key,'hex'),f.scope);
      db.save(f.snapshot); db.begin(1,[f.program],new Map()); db.page(f.program,undefined,[{signature:'A',slot:1,err:null}],2);
      f.snapshot.cursors[f.program]='A'; db.complete('A',f.snapshot); process.exit(23);
    `, fixture, w.path], { encoding: "utf8", timeout: 5000 });
    expect(child.status, child.stderr).toBe(23);
    expect(() => w.open()).toThrow(/owned/); w.advance();
    const a = w.open(); expect(a.pending()).toBe(0); expect(a.snapshot()!.cursors![REGISTRY.toBase58()]).toBe("A");
    expect(a.finish()).toBe(true); expect(() => new IndexerDatabase(w.path, w.key, "wrong scope")).toThrow();
    w.advance(); const b = w.open(); expect(() => a.save(new IndexerStore().snapshot())).toThrow(/lease/); expect(b.through()).toBe(1);
  });
  it("authenticates checkpoint records against their deployment even when a key is reused", () => {
    const w = world(), source = w.open(); source.save(new IndexerStore().snapshot());
    const otherPath = join(w.dir, "other.db"), target = new IndexerDatabase(otherPath, w.key, "different deployment"); cleanup.push(() => target.close());
    target.save(new IndexerStore().snapshot());
    const a = new DatabaseSync(w.path), b = new DatabaseSync(otherPath);
    try { b.prepare("UPDATE state SET data=? WHERE name='snapshot'").run(a.prepare("SELECT data FROM state WHERE name='snapshot'").get()!.data!); }
    finally { a.close(); b.close(); }
    expect(() => target.snapshot()).toThrow();
  });

  it("requires the saved cursor and refuses conflicting transaction evidence without losing scan progress", () => {
    const w = world(), db = w.open(); const program = REGISTRY.toBase58();
    db.begin(1, [program], new Map([[program, "A"]]));
    expect(() => db.page(program, undefined, [info("B")], 2)).toThrow(/cursor missing/);
    expect(db.pending()).toBe(0); expect(db.scan()!.positions[program]!.before).toBeUndefined();
    db.page(program, undefined, [info("B"), info("A")], 2);
    expect(db.oldest().map(v => v.signature)).toEqual(["B"]);
  });
  it("keeps readiness false while catching up, stale or draining and treats hosted webhooks only as hints", async () => {
    const w = world(), db = w.open(), store = new IndexerStore();
    const chain = { getSlot: vi.fn(async () => 1), getSignaturesForAddress: vi.fn(async () => []), getTransaction: w.getTransaction };
    const poller = new Poller(chain as unknown as Connection, store, [REGISTRY], 2, "finalized", config(db));
    const hint = vi.fn(), server = buildServer(store, { database: db, poller: poller.status, webhookSecret: "synthetic", onIngestionHint: hint });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/ready`)).status).toBe(503); await poller.tick();
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      expect((await fetch(`${base}/webhook`, { method: "POST", headers: { authorization: "synthetic" }, body: JSON.stringify({ logs: ["untrusted event"] }) })).status).toBe(202);
      expect(hint).toHaveBeenCalledOnce(); expect(store.pockets.size).toBe(0);
      poller.status.lastHeadAdvancedAt = new Date(Date.now() - 31_000).toISOString();
      expect((await fetch(`${base}/ready`)).status).toBe(503);
      server.drain(); poller.drain();
      expect((await fetch(`${base}/webhook`, { method: "POST", body: "{}" })).status).toBe(503);
      const calls = chain.getSlot.mock.calls.length; await poller.tick(); expect(chain.getSlot).toHaveBeenCalledTimes(calls);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
