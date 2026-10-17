import { describe, expect, it, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { info, stateWorld } from "./state-fixture.js";
const worlds: ReturnType<typeof stateWorld>[] = [];
const setup = () => { const w = stateWorld(); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds) w.cleanup(); worlds.length = 0; });
describe("watcher durable progress regressions", () => {
  it.each([null, ["Log truncated"], ["Program 11111111111111111111111111111111 invoke [1]"]])("refuses missing or truncated logs: %j", async logs => {
    const w = setup(), db = w.open(), notify = vi.fn(async () => {});
    w.chain.getTransaction.mockResolvedValue({ slot: 1, transaction: { signatures: ["A"] }, meta: { err: null, logMessages: logs } });
    await expect(w.watcher(db, { notify }).tick()).rejects.toThrow(/logs/);
    expect(db.snapshot().cursor).toBeUndefined(); expect(db.count()).toBe(1); expect(notify).not.toHaveBeenCalled();
  });
  it("rejects contradictory transaction status and identity without moving the cursor", async () => {
    const w = setup(), db = w.open(), watcher = w.watcher(db);
    w.chain.getTransaction.mockResolvedValue({ slot: 1, transaction: { signatures: ["A"] }, meta: { err: "failed", logMessages: [] } });
    await expect(watcher.tick()).rejects.toThrow(/status/);
    w.chain.getTransaction.mockResolvedValue({ slot: 1, transaction: { signatures: ["other"] }, meta: { err: null, logMessages: [] } });
    await expect(watcher.tick()).rejects.toThrow(/identity/); expect(db.snapshot().cursor).toBeUndefined();
  });
  it("rolls back cursor/pending/dequeue after a real disk transaction failure and retains acknowledged delivery", async () => {
    const w = setup(), db = w.open(), notify = vi.fn(async () => {}), watcher = w.watcher(db, { notify });
    const sql = new DatabaseSync(w.path);
    sql.exec("CREATE TRIGGER refuse_dequeue BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;");
    try {
      await expect(watcher.tick()).rejects.toThrow(/synthetic/);
      expect(db.snapshot()).toEqual({ pending: [] }); expect(watcher.pending.size).toBe(0);
      expect(db.count()).toBe(1); expect(db.delivery()?.next).toBe(1);
      sql.exec("DROP TRIGGER refuse_dequeue"); await watcher.tick();
      expect(db.snapshot().cursor).toBe("A"); expect(watcher.pending.size).toBe(1); expect(notify).toHaveBeenCalledOnce();
    } finally { sql.close(); }
  });
  it("rejects repeated pages and missing cursors while preserving scan progress", async () => {
    const w = setup(), db = w.open(), watcher = w.watcher(db, undefined, { pageSize: 2 });
    w.chain.getSignaturesForAddress.mockResolvedValue([info("B"), info("A")]);
    await expect(watcher.tick()).rejects.toThrow(/history/); expect(w.chain.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    expect(db.count()).toBe(2); expect(db.scan()?.before).toBe("A");
    w.chain.getSignaturesForAddress.mockResolvedValue([]); await watcher.tick(); expect(db.snapshot().cursor).toBe("B");
    w.chain.getSignaturesForAddress.mockResolvedValue([info("C")]); await expect(watcher.tick()).rejects.toThrow(/cursor missing/);
    expect(db.count()).toBe(0); expect(db.scan()?.before).toBeUndefined();
  });
});
