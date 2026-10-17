import { mkdtempSync, rmSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { POCKET, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import { Watcher } from "../src/index.js";
import { world } from "./fixture.js";

const pocket = Keypair.generate().publicKey;
const after = Buffer.alloc(8); after.writeBigUInt64LE(100n);
const logs = frameAsProgramLogs(POCKET.toBase58(), [`Program data: ${Buffer.concat([
  eventDisc("ChangeProposed"), pocket.toBytes(), after,
]).toString("base64")}`]);
const info = (signature: string, err: unknown = null) => ({ signature, slot: 1, err, memo: null, blockTime: 0 });

describe("watcher recovery", () => {
  it("refuses funded work when pending progress cannot be persisted", async () => {
    const w = world(); w.slot(1);
    try {
      const watcher = w.watcher(); await watcher.tick(); unlinkSync(w.state); mkdirSync(w.state);
      w.slot(101);
      await expect(watcher.tick()).rejects.toThrow();
      expect(w.chain.sendRawTransaction).not.toHaveBeenCalled(); expect(watcher.pending.size).toBe(1);
    } finally { w.cleanup(); }
  });
  it("refuses a durable observer snapshot from another chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-watcher-scope-")), path = join(dir, "state.json");
    const genesis = Keypair.generate().publicKey.toBase58();
    const connection = {
      getSignaturesForAddress: vi.fn(async () => [info("proposal")]),
      getTransaction: vi.fn(async () => ({ meta: { err: null, logMessages: logs } })),
      getSlot: vi.fn(async () => 1),
    };
    try {
      await new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, undefined, path, genesis).tick();
      expect(() => new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, undefined, path, Keypair.generate().publicKey.toBase58())).toThrow(/snapshot/);
      expect(new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, undefined, path, genesis).pending.size).toBe(1);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      for (const pending of [[[99, "100"]], [[pocket.toBase58(), 100]], [[pocket.toBase58(), "100"], [pocket.toBase58(), "200"]]]) {
        writeFileSync(path, JSON.stringify({ ...saved, pending }));
        expect(() => new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, undefined, path, genesis)).toThrow(/snapshot/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("paginates a backlog beyond 1000 signatures before advancing its cursor", async () => {
    const notify = vi.fn(async () => {});
    const connection = {
      getSignaturesForAddress: vi.fn(async (_program, options) => options.before
        ? [info("old-proposal")] : Array.from({ length: 1000 }, (_, n) => info(`new-${1000 - n}`, "failed"))),
      getTransaction: vi.fn(async () => ({ meta: { err: null, logMessages: logs } })),
    };
    await new Watcher(connection as unknown as Connection, { notify }, 1n).tick();
    expect(connection.getSignaturesForAddress).toHaveBeenNthCalledWith(2, POCKET,
      { limit: 1000, before: "new-1", until: undefined }, "confirmed");
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[1]).toMatchObject({ signature: "old-proposal" });
  });

  it("does not alert or schedule a rolled-back transaction", async () => {
    const notify = vi.fn(async () => {});
    const connection = {
      getSignaturesForAddress: vi.fn(async () => [info("failed")]),
      getTransaction: vi.fn(async () => ({ meta: { err: "failed", logMessages: logs } })),
    };
    const watcher = new Watcher(connection as unknown as Connection, { notify }, 1n);
    await watcher.tick();
    expect(watcher.pending.size).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
