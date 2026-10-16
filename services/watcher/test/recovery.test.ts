import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, SystemProgram } from "@solana/web3.js";
import { POCKET, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import { Watcher } from "../src/index.js";

const pocket = Keypair.generate().publicKey;
const after = Buffer.alloc(8); after.writeBigUInt64LE(100n);
const logs = frameAsProgramLogs(POCKET.toBase58(), [`Program data: ${Buffer.concat([
  eventDisc("ChangeProposed"), pocket.toBytes(), after,
]).toString("base64")}`]);
const info = (signature: string, err: unknown = null) => ({ signature, slot: 1, err, memo: null, blockTime: 0 });

describe("watcher recovery", () => {
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
      sendRawTransaction: vi.fn(async () => "crank"),
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
