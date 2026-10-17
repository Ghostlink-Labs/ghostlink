import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PendingChanges } from "../src/index.js";
import { info, pocket, stateWorld } from "./state-fixture.js";
import { world } from "./fixture.js";
const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.reverse()) fn(); clean.length = 0; });
const setup = () => { const w = stateWorld(); clean.push(w.cleanup); return w; };
describe("watcher recovery", () => {
  it("refuses funded work when pending progress cannot be persisted", async () => {
    const w = world(); clean.push(w.cleanup); w.slot(1);
    const watcher = w.watcher(); await watcher.tick(); w.slot(101);
    const sql = new DatabaseSync(w.state);
    sql.exec("CREATE TRIGGER refuse_state BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;");
    try { await expect(watcher.tick()).rejects.toThrow(); expect(w.chain.sendRawTransaction).not.toHaveBeenCalled(); expect(watcher.pending.size).toBe(1); }
    finally { sql.close(); }
  });
  it("binds delivery state to deployment, receiver, threshold and worker ownership", async () => {
    const w = setup(), db = w.open(); expect(() => w.open()).toThrow(/owned/);
    for (const scope of [{ ...w.scope, genesisHash: pocket.toBase58() }, { ...w.scope, receiver: "another" }, { ...w.scope, threshold: "2" }]) expect(() => w.open(scope)).toThrow();
    db.close(); const resumed = w.open(); expect(resumed.snapshot()).toEqual({ pending: [] });
    w.advance(90_001); const replacement = w.open(); expect(() => resumed.renew()).toThrow(/ownership/); replacement.renew();
    const pending = new PendingChanges();
    for (const entries of [[[99, "100"]], [[pocket.toBase58(), 100]], [[pocket.toBase58(), "100"], [pocket.toBase58(), "200"]]]) expect(() => pending.restore(entries as any)).toThrow();
  });
  it("resumes bounded backlog pagination and delivery in chronological order across restart", async () => {
    const w = setup(); let db = w.open();
    const rows = Array.from({ length: 77 }, (_, n) => info(`S${77 - n}`, 77 - n)); w.chain.getSlot.mockResolvedValue(60);
    w.chain.getSignaturesForAddress.mockImplementation(async (_p: any, config: any) => {
      const start = config.before ? rows.findIndex(row => row.signature === config.before) + 1 : 0; return rows.slice(start, start + config.limit);
    });
    const read = w.chain.getTransaction.getMockImplementation()!;
    w.chain.getTransaction.mockImplementation(async signature => ({ ...await read(signature), slot: Number(signature.slice(1)) }));
    const delivered: string[] = [], notify = async (_subject: string, body: Record<string, unknown>) => { delivered.push(String(body.signature)); };
    const limits = { pageSize: 7, maximumPages: 2, maximumTransactions: 3, maximumDeliveries: 2 };
    let watcher = w.watcher(db, { notify }, limits);
    await watcher.tick(); expect(delivered).toEqual([]); expect(w.chain.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    watcher.close(); db = w.open(); watcher = w.watcher(db, { notify }, limits);
    for (let n = 0; n < 80 && watcher.status.catchingUp; n++) { const before = delivered.length; await watcher.tick(); expect(delivered.length - before).toBeLessThanOrEqual(2); }
    expect(watcher.status.catchingUp).toBe(false); expect(db.snapshot().cursor).toBe("S60");
    expect(delivered).toEqual(Array.from({ length: 60 }, (_, n) => `S${n + 1}`)); expect(w.chain.getSlot).toHaveBeenCalledOnce();
  });
  it("does not alert or schedule a consistently failed transaction", async () => {
    const w = setup(), notify = vi.fn(async () => {}), db = w.open();
    w.chain.getSignaturesForAddress.mockResolvedValue([info("A", 1, "failed")]);
    const watcher = w.watcher(db, { notify }); await watcher.tick();
    expect(watcher.pending.size).toBe(0); expect(notify).not.toHaveBeenCalled(); expect(w.chain.getTransaction).not.toHaveBeenCalled(); expect(db.snapshot().cursor).toBe("A");
  });
});
