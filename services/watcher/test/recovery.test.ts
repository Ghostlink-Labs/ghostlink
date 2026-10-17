import { mkdtempSync, rmSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { POCKET, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import { Watcher } from "../src/index.js";

const pocket = Keypair.generate().publicKey;
const after = Buffer.alloc(8); after.writeBigUInt64LE(100n);
const logs = frameAsProgramLogs(POCKET.toBase58(), [`Program data: ${Buffer.concat([
  eventDisc("ChangeProposed"), pocket.toBytes(), after,
]).toString("base64")}`]);
const info = (signature: string, err: unknown = null) => ({ signature, slot: 1, err, memo: null, blockTime: 0 });

describe("watcher recovery", () => {
  it("refuses funded work when pending progress cannot be persisted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ghostlink-watcher-write-")), path = join(directory, "state.json");
    const connection = {
      getSignaturesForAddress: vi.fn(async (_program, options) => options.until ? [] : [info("proposal")]),
      getTransaction: vi.fn(async () => ({ meta: { err: null, logMessages: logs } })),
      getSlot: vi.fn(async () => 1),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 200 })),
      sendRawTransaction: vi.fn(async (bytes: Uint8Array) => bs58.encode(Transaction.from(bytes).signature!)),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    };
    try {
      const watcher = new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, Keypair.generate(), path);
      await watcher.tick(); unlinkSync(path); mkdirSync(path);
      connection.getSlot.mockResolvedValue(101);
      await expect(watcher.tick()).rejects.toThrow();
      expect(connection.sendRawTransaction).not.toHaveBeenCalled();
      expect(watcher.pending.size).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["ack", "error"])("retains pending changes across restart after RPC %s without leaking diagnostics", async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-watcher-"));
    const statePath = join(dir, "state.json");
    const marker = "SYNTHETIC_WATCHER_PROVIDER_SECRET";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const payer = Keypair.generate();
    const notify = vi.fn(async () => {});
    const connection = {
      getSignaturesForAddress: vi.fn(async (_program, options) => options.until ? [] : [info("proposal")]),
      getTransaction: vi.fn(async () => ({ meta: { err: null, logMessages: logs } })),
      getSlot: vi.fn(async () => 101),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 200 })),
      sendRawTransaction: vi.fn(async (_bytes: Uint8Array) => {
        if (mode === "error") throw new Error(marker);
        return bs58.encode(new Uint8Array(64).fill(7));
      }),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    };
    try {
      const watcher = new Watcher(connection as unknown as Connection, { notify }, 1n, payer, statePath);
      await watcher.tick();
      expect(watcher.pending.size).toBe(1);
      expect(connection.confirmTransaction).not.toHaveBeenCalled();
      const restored = new Watcher(connection as unknown as Connection, { notify }, 1n, payer, statePath);
      expect(restored.pending.size).toBe(1);
      connection.sendRawTransaction.mockRejectedValueOnce(new Error(marker));
      await restored.tick();
      expect(restored.pending.size).toBe(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
      connection.sendRawTransaction.mockImplementation(async bytes => bs58.encode(Transaction.from(bytes).signature!));
      await restored.tick();
      const bytes = connection.sendRawTransaction.mock.calls.at(-1)![0];
      expect(connection.confirmTransaction).toHaveBeenCalledWith(expect.objectContaining({ signature: bs58.encode(Transaction.from(bytes).signature!) }), "confirmed");
      expect(restored.pending.size).toBe(0);
      expect(notify).toHaveBeenCalledOnce(); // Execution alert still waits for the actual event.
    } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a durable snapshot from another chain or crank payer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-watcher-scope-")), path = join(dir, "state.json");
    const genesis = Keypair.generate().publicKey.toBase58(), payer = Keypair.generate();
    const connection = {
      getSignaturesForAddress: vi.fn(async () => [info("proposal")]),
      getTransaction: vi.fn(async () => ({ meta: { err: null, logMessages: logs } })),
      getSlot: vi.fn(async () => 1),
    };
    try {
      await new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, payer, path, genesis).tick();
      expect(() => new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, payer, path, Keypair.generate().publicKey.toBase58())).toThrow(/snapshot/);
      expect(() => new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, Keypair.generate(), path, genesis)).toThrow(/snapshot/);
      expect(new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, payer, path, genesis).pending.size).toBe(1);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      for (const pending of [[[99, "100"]], [[pocket.toBase58(), 100]], [[pocket.toBase58(), "100"], [pocket.toBase58(), "200"]]]) {
        writeFileSync(path, JSON.stringify({ ...saved, pending }));
        expect(() => new Watcher(connection as unknown as Connection, { notify: async () => {} }, 1n, payer, path, genesis)).toThrow(/snapshot/);
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

  it("restores delivered cursor and pending timelocks, and keeps failed cranks pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-watcher-"));
    const statePath = join(dir, "state.json");
    const notify = vi.fn(async (_subject: string, _body: Record<string, unknown>) => {});
    const connection = {
      getSignaturesForAddress: vi.fn(async (_program, options) => options.until ? [] : [info("proposal")]),
      getTransaction: vi.fn(async () => ({ meta: { err: null, logMessages: logs } })),
      getSlot: vi.fn(async () => 101),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 200 })),
      sendRawTransaction: vi.fn(async (bytes: Uint8Array) => bs58.encode(Transaction.from(bytes).signature!)),
      confirmTransaction: vi.fn(async () => ({ value: { err: { InstructionError: [0, "Custom"] } } })),
    };
    try {
      await new Watcher(connection as unknown as Connection, { notify }, 1n, undefined, statePath).tick();
      const restored = new Watcher(connection as unknown as Connection, { notify }, 1n, Keypair.generate(), statePath);
      expect(restored.pending.due(101n)).toEqual([pocket.toBase58()]);
      await restored.tick();
      expect(restored.pending.size).toBe(1);
      expect(notify).toHaveBeenCalledOnce();
      expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
      expect(new Watcher(connection as unknown as Connection, { notify }, 1n, undefined, statePath).pending.size).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
