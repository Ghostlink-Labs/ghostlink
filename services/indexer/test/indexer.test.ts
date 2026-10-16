/**
 * Store + event-decode round trip: synthesize the exact event bytes the
 * programs emit, feed them through the log decoder into the store, and
 * check the served paths verify against the roots — including over HTTP.
 * Plus the refusal cases: gaps, bad roots, conflicting replays, foreign
 * emitters, unauthenticated webhooks and roots the chain never had.
 */
import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CENSUS_PROGRAM_ID,
  IncrementalTree,
  REGISTRY_PROGRAM_ID,
  POCKET_PROGRAM_ID,
  fieldToBytes32,
  registryLeaf,
  censusLeaf,
  commitment,
  secretToField,
} from "@ghostlink/common";
import { decodeLogs, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import bs58 from "bs58";
import { IndexerStore } from "../src/store.js";
import { buildServer } from "../src/server.js";
import type { ChainRoots } from "../src/chain-roots.js";

const wallet = new Uint8Array(32).fill(7);
const mint = new Uint8Array(32).fill(9);

function registeredLog(leafIndex: bigint, leaf: Uint8Array, root: Uint8Array, w: Uint8Array = wallet): string {
  const c = new Uint8Array(32).fill(3);
  const buf = Buffer.concat([Buffer.from(eventDisc("Registered")), u64(leafIndex), leaf, root, w, c]);
  return `Program data: ${buf.toString("base64")}`;
}

function snapshotLog(leafIndex: bigint, leaf: Uint8Array, root: Uint8Array, amount: bigint, slot: bigint): string {
  const buf = Buffer.concat([
    Buffer.from(eventDisc("SnapshotTaken")),
    u64(leafIndex),
    leaf,
    root,
    wallet,
    mint,
    u64(amount),
    u64(slot),
  ]);
  return `Program data: ${buf.toString("base64")}`;
}

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

const registryLogs = (lines: string[]) => frameAsProgramLogs(REGISTRY_PROGRAM_ID, lines);
const censusLogs = (lines: string[]) => frameAsProgramLogs(CENSUS_PROGRAM_ID, lines);

function seedStore(): { store: IndexerStore; regRoot: string; cenRoot: string; regTree: IncrementalTree; firstLog: string } {
  const store = new IndexerStore();
  const s = secretToField(new Uint8Array(32).fill(1));
  const regTree = new IncrementalTree();
  const lReg = registryLeaf(wallet, commitment(s));
  regTree.append(lReg);
  const cenTree = new IncrementalTree();
  const lCen = censusLeaf(wallet, mint, 42n, 100n);
  cenTree.append(lCen);

  const firstLog = registeredLog(0n, fieldToBytes32(lReg), fieldToBytes32(regTree.root));
  const logs = [
    ...registryLogs([firstLog]),
    ...censusLogs([snapshotLog(0n, fieldToBytes32(lCen), fieldToBytes32(cenTree.root), 42n, 100n)]),
  ];
  for (const event of decodeLogs(logs)) store.apply(event);
  return { store, regRoot: regTree.root.toString(), cenRoot: cenTree.root.toString(), regTree, firstLog };
}

async function withServer<T>(
  store: IndexerStore,
  options: Parameters<typeof buildServer>[1],
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = buildServer(store, options);
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

describe("indexer store", () => {
  it("deduplicates pocket transactions across replay and snapshot restore", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-indexer-"));
    const path = join(dir, "snapshot.json");
    try {
      const store = new IndexerStore(path);
      const opened = { kind: "SessionOpened" as const, pocket: "pocket", appId: new Uint8Array(32), created: true, sessionExpirySlot: 100n };
      expect(store.applyTransaction("open", [opened])).toBe(1);
      expect(store.applyTransaction("revoke", [{ kind: "SessionRevoked", pocket: "pocket" }])).toBe(1);
      store.flush();
      const restored = IndexerStore.load(path);
      expect(restored.applyTransaction("open", [opened])).toBe(0);
      expect(restored.pockets.get("pocket")?.revoked).toBe(true);
      expect(restored.activity).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rebuilds trees from events and serves verifiable paths", () => {
    const { store, regRoot, cenRoot } = seedStore();
    expect(store.recentRoots("registry")).toContain(regRoot);
    expect(store.recentRoots("census")).toContain(cenRoot);
    expect(store.bindings.get(bs58.encode(wallet))?.leafIndex).toBe(0);
    const entry = store.latestCensus.get(`${bs58.encode(wallet)}:${bs58.encode(mint)}`);
    expect(entry?.amount).toBe("42");

    const path = store.registry.path(0);
    expect(IncrementalTree.verify(BigInt(store.registryLeaves[0]!), path, store.registry.root)).toBe(true);
  });

  it("refuses an event whose root does not chain, leaving the tree untouched", () => {
    const { store } = seedStore();
    const badRoot = new Uint8Array(32).fill(5);
    const leaf = fieldToBytes32(123n);
    const rootBefore = store.registry.root;
    expect(() =>
      store.apply({
        kind: "Registered",
        leafIndex: 1n,
        leaf,
        root: badRoot,
        wallet: bs58.encode(wallet),
        commitment: new Uint8Array(32),
      }),
    ).toThrow(/root mismatch/);
    expect(store.registry.nextIndex).toBe(1);
    expect(store.registry.root).toBe(rootBefore);
    expect(store.registryLeaves).toHaveLength(1);
  });

  it("refuses a gap without mutating, then accepts the missing leaf", () => {
    const { store, regTree } = seedStore();
    const l1 = registryLeaf(new Uint8Array(32).fill(8), commitment(secretToField(new Uint8Array(32).fill(2))));
    const l2 = registryLeaf(new Uint8Array(32).fill(9), commitment(secretToField(new Uint8Array(32).fill(3))));
    regTree.append(l1);
    const rootAfter1 = regTree.root;
    regTree.append(l2);
    const rootAfter2 = regTree.root;

    const gap = decodeLogs(registryLogs([registeredLog(2n, fieldToBytes32(l2), fieldToBytes32(rootAfter2))]))[0]!;
    expect(() => store.apply(gap)).toThrow(/gap/);
    expect(store.registry.nextIndex).toBe(1);

    const next = decodeLogs(registryLogs([registeredLog(1n, fieldToBytes32(l1), fieldToBytes32(rootAfter1))]))[0]!;
    expect(store.apply(next)).toBe(true);
    expect(store.apply(gap)).toBe(true);
    expect(store.registry.root).toBe(rootAfter2);
  });

  it("treats a redelivered identical leaf as a no-op and a conflicting one as fatal", () => {
    const { store, firstLog } = seedStore();
    const replay = decodeLogs(registryLogs([firstLog]))[0]!;
    expect(store.apply(replay)).toBe(false);
    expect(store.registry.nextIndex).toBe(1);

    const conflicting = decodeLogs(
      registryLogs([registeredLog(0n, fieldToBytes32(777n), fieldToBytes32(store.registry.root))]),
    )[0]!;
    expect(() => store.apply(conflicting)).toThrow(/different contents/);
    expect(store.registry.nextIndex).toBe(1);
  });

  it("ignores byte-identical events from a foreign program", () => {
    const { firstLog } = seedStore();
    const store = new IndexerStore();
    const forged = decodeLogs(frameAsProgramLogs("Attack3r11111111111111111111111111111111111", [firstLog]));
    expect(forged).toHaveLength(0);
    expect(store.registry.nextIndex).toBe(0);
  });

  it("serves roots and paths over HTTP", async () => {
    const { store, regRoot } = seedStore();
    await withServer(store, {}, async (base) => {
      const roots = (await (await fetch(`${base}/roots/registry`)).json()) as { roots: string[]; nextIndex: number };
      expect(roots.roots).toContain(regRoot);
      expect(roots.nextIndex).toBe(1);

      const path = (await (await fetch(`${base}/path/registry/0`)).json()) as { siblings: string[]; root: string };
      expect(path.root).toBe(regRoot);
      expect(path.siblings.length).toBe(26);

      expect((await fetch(`${base}/path/registry/abc`)).status).toBe(400);
      expect((await fetch(`${base}/path/registry/5`)).status).toBe(404);
      // Browser preflight for any route answers 204 with CORS headers.
      const pre = await fetch(`${base}/roots/registry`, { method: "OPTIONS" });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    });
  });

  it("cannot bypass the leaf page cap using negative or fractional limits", async () => {
    const store = new IndexerStore();
    store.registryLeaves = Array.from({ length: 6000 }, () => "1");
    await withServer(store, {}, async (base) => {
      for (const limit of ["-1", "0", "1.5", "NaN", "Infinity"]) {
        expect((await fetch(`${base}/leaves/registry?limit=${limit}`)).status).toBe(400);
      }
      const response = await fetch(`${base}/leaves/registry?limit=10000`);
      expect((await response.json()).leaves).toHaveLength(5000);
    });
  });

  it("webhook: off without a secret, 401 with the wrong one, applies with the right one", async () => {
    const { store, regTree } = seedStore();
    const l1 = registryLeaf(new Uint8Array(32).fill(8), commitment(secretToField(new Uint8Array(32).fill(2))));
    regTree.append(l1);
    const body = JSON.stringify({ logs: registryLogs([registeredLog(1n, fieldToBytes32(l1), fieldToBytes32(regTree.root))]) });
    const headers = { "content-type": "application/json" };

    await withServer(store, {}, async (base) => {
      expect((await fetch(`${base}/webhook`, { method: "POST", headers, body })).status).toBe(404);
    });
    await withServer(store, { webhookSecret: "s3cret" }, async (base) => {
      expect((await fetch(`${base}/webhook`, { method: "POST", headers, body })).status).toBe(401);
      expect(
        (await fetch(`${base}/webhook`, { method: "POST", headers: { ...headers, authorization: "wrong" }, body })).status,
      ).toBe(401);
      expect(store.registry.nextIndex).toBe(1);
      const ok = await fetch(`${base}/webhook`, { method: "POST", headers: { ...headers, authorization: "s3cret" }, body });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ applied: 1, ignored: 0 });
      expect(store.registry.nextIndex).toBe(2);
      // Redelivery is harmless.
      const again = await fetch(`${base}/webhook`, { method: "POST", headers: { ...headers, authorization: "s3cret" }, body });
      expect(await again.json()).toEqual({ applied: 0, ignored: 1 });
      expect(store.registry.nextIndex).toBe(2);
    });
  });

  it("webhook: a well-formed event whose root the chain never had is ignored", async () => {
    const { store, regTree } = seedStore();
    const l1 = registryLeaf(new Uint8Array(32).fill(8), commitment(secretToField(new Uint8Array(32).fill(2))));
    regTree.append(l1);
    const chainRoots = { contains: async () => false } as unknown as ChainRoots;
    const body = JSON.stringify({ logs: registryLogs([registeredLog(1n, fieldToBytes32(l1), fieldToBytes32(regTree.root))]) });
    await withServer(store, { webhookSecret: "s3cret", chainRoots }, async (base) => {
      const res = await fetch(`${base}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
        body,
      });
      expect(await res.json()).toEqual({ applied: 0, ignored: 1 });
      expect(store.registry.nextIndex).toBe(1);
    });
  });

  it("webhook: failed transactions in a Helius batch are skipped", async () => {
    const { store, regTree } = seedStore();
    const l1 = registryLeaf(new Uint8Array(32).fill(8), commitment(secretToField(new Uint8Array(32).fill(2))));
    regTree.append(l1);
    const logMessages = registryLogs([registeredLog(1n, fieldToBytes32(l1), fieldToBytes32(regTree.root))]);
    await withServer(store, { webhookSecret: "s3cret" }, async (base) => {
      const res = await fetch(`${base}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "s3cret" },
        body: JSON.stringify([{ meta: { err: { InstructionError: [0, "Custom"] }, logMessages } }]),
      });
      expect(await res.json()).toEqual({ applied: 0, ignored: 0 });
      expect(store.registry.nextIndex).toBe(1);
    });
  });

  it("requires pocket transaction identities and deduplicates retry delivery", async () => {
    const store = new IndexerStore();
    const logs = frameAsProgramLogs(POCKET_PROGRAM_ID, [`Program data: ${Buffer.concat([
      eventDisc("SessionOpened"), wallet, Buffer.alloc(32), Buffer.from([1]), u64(100n),
    ]).toString("base64")}`]);
    await withServer(store, { webhookSecret: "secret" }, async (base) => {
      const post = (signature?: string) => fetch(`${base}/webhook`, { method: "POST",
        headers: { "content-type": "application/json", authorization: "secret" }, body: JSON.stringify({ logs, signature }) });
      expect((await post()).status).toBe(400);
      expect(await (await post("transaction")).json()).toEqual({ applied: 1, ignored: 0 });
      expect(await (await post("transaction")).json()).toEqual({ applied: 0, ignored: 1 });
      expect(store.activity).toHaveLength(1);
    });
  });
});
