import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, SystemProgram } from "@solana/web3.js";
import { IncrementalTree, fieldToBytes32, ROOT_HISTORY_SIZE, TREE_DEPTH } from "@ghostlink/common";
import { CENSUS, REGISTRY, POCKET } from "@ghostlink/service-kit";
import { IndexerDatabase } from "../src/database.js";
import { IndexerStore } from "../src/store.js";
import { Poller, type PollerOptions } from "../src/poller.js";
import { buildServer } from "../src/server.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0; });
const rootsOffset = 16 + 32 * TREE_DEPTH;
function account(tree: IncrementalTree, owner = REGISTRY) {
  const data = Buffer.alloc(rootsOffset + 32 * ROOT_HISTORY_SIZE + 8);
  createHash("sha256").update("account:TreeState").digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(BigInt(tree.nextIndex), 8);
  data[rootsOffset + 32 * ROOT_HISTORY_SIZE] = tree.nextIndex % ROOT_HISTORY_SIZE;
  Buffer.from(fieldToBytes32(tree.root)).copy(data, rootsOffset + 32 * (tree.nextIndex % ROOT_HISTORY_SIZE));
  return { owner, data, executable: false, lamports: 1, rentEpoch: 0 };
}
function world(options: Partial<PollerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "indexer-reconciliation-")), key = randomBytes(32), path = join(dir, "state.sqlite");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => { const db = new IndexerDatabase(path, key, "synthetic root reconciliation"); cleanup.push(() => db.close()); return db; };
  const database = open();
  const store = new IndexerStore(), registry = new IncrementalTree(), census = new IncrementalTree();
  const connection = { getSlot: vi.fn(async () => 10), getSignaturesForAddress: vi.fn(async () => []),
    getMultipleAccountsInfoAndContext: vi.fn(async (_addresses?: unknown, _config?: { commitment: string; minContextSlot: number }) =>
      ({ context: { slot: 10 }, value: [account(registry), account(census, CENSUS)] })) };
  const poller = new Poller(connection as unknown as Connection, store, undefined, 1000, "finalized",
    { database, paceMs: 0, reconcileRoots: true, ...options });
  return { database, open, store, registry, census, connection, poller };
}

it("does not declare an empty RPC history ready when the finalized tree has a leaf", async () => {
  const w = world(); w.registry.append(7n);
  const server = buildServer(w.store, { database: w.database, poller: w.poller.status });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await w.poller.tick().catch(() => undefined);
    expect((await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/ready`)).status).toBe(503);
    expect(w.database.through()).toBe(0);
    expect(w.database.scan()).toBeDefined();
    for (const route of ["roots/registry", "leaves/census", "path/registry/0", "registry/binding/example", "census/latest", "pockets/example", "activity/example", "stats"]) {
      expect((await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/${route}`)).status).toBe(503);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("refuses a conflicting root even when leaf counts agree", async () => {
  const w = world(); w.registry.append(7n); w.store.registry.append(8n); w.store.registryLeaves.push("8"); w.database.save(w.store.snapshot());
  await expect(w.poller.tick()).rejects.toThrow(/match finalized/);
  expect(w.database.through()).toBe(0); expect(w.database.scan()!.treeAnchor!.registry.nextIndex).toBe(1);
});

it("retains its original anchor across a bounded scan and database reopen", async () => {
  const w = world({ maximumPages: 1 });
  await w.poller.tick(); expect(w.database.scan()!.nextProgram).toBe(1);
  const anchor = w.database.scan()!.treeAnchor; w.database.close();
  w.registry.append(9n); // Arrives after the saved finalized slot; belongs to the next scan.
  w.connection.getMultipleAccountsInfoAndContext.mockImplementation(async (_addresses, config) => {
    expect(config?.commitment).toBe("confirmed");
    const current = account(w.registry);
    Buffer.from(fieldToBytes32(BigInt(anchor!.registry.root))).copy(current.data, rootsOffset);
    return { context: { slot: 20 }, value: [current, account(w.census, CENSUS)] };
  });
  const reopened = w.open(), poller = new Poller(w.connection as unknown as Connection, new IndexerStore(), undefined, 1000, "finalized",
    { database: reopened, reconcileRoots: true, maximumPages: 1, paceMs: 0 });
  expect(reopened.scan()!.treeAnchor).toEqual(anchor);
  await poller.tick(); await poller.tick();
  expect(reopened.through()).toBe(10); expect(reopened.scan()).toBeUndefined(); expect(poller.status.rootsUsable).toBe(true);
  expect(w.connection.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(2);
  expect(w.connection.getSlot).not.toHaveBeenCalled();
});

it("withholds paths while a new scan is in flight and when root checks expire", async () => {
  const w = world(); await w.poller.tick();
  const server = buildServer(w.store, { database: w.database, poller: w.poller.status });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/leaves/registry`;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = w.connection.getMultipleAccountsInfoAndContext.getMockImplementation()!;
  w.connection.getMultipleAccountsInfoAndContext.mockImplementationOnce(async (...args) => { await held; return original(...args); });
  const tick = w.poller.tick();
  try {
    expect((await fetch(url)).status).toBe(503);
    release(); await tick; expect((await fetch(url)).status).toBe(200);
    w.poller.status.rootsCheckedAt = new Date(Date.now() - 31_000).toISOString();
    expect((await fetch(url)).status).toBe(503);
  } finally { release(); await tick; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each(["missing", "owner", "executable", "truncated", "discriminator", "index", "cursor", "field", "context"])("refuses %s account evidence before scanning", async variant => {
  const w = world();
  w.connection.getMultipleAccountsInfoAndContext.mockImplementation(async () => {
    const a = account(w.registry), b = account(w.census, CENSUS);
    if (variant === "missing") return { context: { slot: 10 }, value: [null, b] } as never;
    if (variant === "owner") a.owner = SystemProgram.programId;
    if (variant === "executable") a.executable = true;
    if (variant === "truncated") a.data = a.data.subarray(0, -1);
    if (variant === "discriminator") a.data[0] ^= 1;
    if (variant === "index") a.data.writeBigUInt64LE(1n << 50n, 8);
    if (variant === "cursor") a.data[rootsOffset + 32 * ROOT_HISTORY_SIZE] = 1;
    if (variant === "field") a.data.fill(255, rootsOffset, rootsOffset + 32);
    return { context: { slot: variant === "context" ? -1 : 10 }, value: [a, b] };
  });
  await expect(w.poller.tick()).rejects.toThrow();
  expect(w.database.scan()).toBeUndefined(); expect(w.connection.getSignaturesForAddress).not.toHaveBeenCalled();
});

it("does not silently attach current roots to a legacy in-progress scan", async () => {
  const w = world(); w.database.begin(9, [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), w.store.cursors);
  await expect(w.poller.tick()).rejects.toThrow(/legacy scan/);
  expect(w.database.scan()!.upperSlot).toBe(9); expect(w.database.scan()!.treeAnchor).toBeUndefined();
  expect(w.connection.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
});

it.each([127, 128])("reports usable roots only while the saved root survives %i later appends", async count => {
  const w = world();
  w.connection.getMultipleAccountsInfoAndContext.mockImplementation(async (_addresses, config) => {
    const a = account(w.registry), b = account(w.census, CENSUS);
    if (config?.commitment === "confirmed") {
      a.data.writeBigUInt64LE(BigInt(count), 8); a.data[rootsOffset + 32 * ROOT_HISTORY_SIZE] = count % ROOT_HISTORY_SIZE;
      if (count === 128) Buffer.from(fieldToBytes32(123n)).copy(a.data, rootsOffset);
    }
    return { context: { slot: 10 }, value: [a, b] };
  });
  await w.poller.tick(); expect(w.database.through()).toBe(10); expect(w.poller.status.rootsUsable).toBe(count < 128);
  const server = buildServer(w.store, { database: w.database, poller: w.poller.status });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { expect((await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/ready`)).status).toBe(count < 128 ? 200 : 503); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("preserves a reconciled checkpoint on probe outage and rejects regressing confirmed evidence", async () => {
  const w = world(); let confirmed = 20;
  w.connection.getMultipleAccountsInfoAndContext.mockImplementation(async (_addresses, config) => {
    if (config?.commitment === "confirmed" && confirmed === -1) throw new Error("synthetic outage");
    return { context: { slot: config?.commitment === "confirmed" ? confirmed : 10 }, value: [account(w.registry), account(w.census, CENSUS)] };
  });
  await w.poller.tick(); expect(w.poller.status.rootsUsable).toBe(true);
  confirmed = -1; await expect(w.poller.tick()).rejects.toThrow(/outage/);
  expect(w.database.through()).toBe(10); expect(w.poller.status.rootsUsable).toBe(false);
  confirmed = 19; await expect(w.poller.tick()).rejects.toThrow(/regressed/);
  expect(w.connection.getMultipleAccountsInfoAndContext.mock.calls.at(-1)![1]).toMatchObject({ minContextSlot: 20 });
  confirmed = 21; await w.poller.tick(); expect(w.poller.status.rootsUsable).toBe(true);
});
