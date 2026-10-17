import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebhookNotifier } from "../src/index.js";
import { info, pocket, stateWorld } from "./state-fixture.js";
const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.reverse()) fn(); clean.length = 0; });
const setup = () => { const w = stateWorld(); clean.push(w.cleanup); return w; };

describe("durable notification delivery", () => {
  it("detects changed or deleted queued observations before they can skip an owner alert", () => {
    const w = setup(), db = w.open(); db.begin(1); db.page(undefined, [info("B"), info("A")], 1000);
    const sql = new DatabaseSync(w.path);
    try {
      sql.exec("UPDATE observations SET failed=1 WHERE signature='A'"); expect(() => db.oldest()).toThrow(/metadata/);
      sql.exec("DELETE FROM observations WHERE signature='A'"); expect(() => db.oldest()).toThrow(/missing/);
      expect(db.snapshot().cursor).toBeUndefined(); expect(db.finish()).toBe(false);
    } finally { sql.close(); }
  });
  it("retries the exact persisted alert after a receiver accepts it but loses its reply, without rereading RPC", async () => {
    const w = setup(), received: Record<string, unknown>[] = [];
    const receiver = createServer(async (req, res) => {
      const parts = []; for await (const part of req) parts.push(Buffer.from(part)); received.push(JSON.parse(Buffer.concat(parts).toString()));
      if (received.length === 1) res.destroy(); else { res.writeHead(200); res.end(); }
    });
    receiver.listen(0, "127.0.0.1"); await once(receiver, "listening");
    const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`, notifier = new WebhookNotifier(url);
    try {
      const first = w.watcher(undefined, notifier); await expect(first.tick()).rejects.toThrow(/delivery failed/);
      expect(first.state.snapshot().cursor).toBeUndefined(); expect(first.state.delivery()?.next).toBe(0);
      const saved = first.state.delivery()!.alerts[0]!.body; first.close();
      w.chain.getTransaction.mockRejectedValue(new Error("RPC cannot reconstruct old delivery"));
      const restarted = w.watcher(undefined, notifier); await restarted.tick();
      expect(received).toHaveLength(2); expect(received[1]).toEqual(received[0]);
      expect(received[1]).toMatchObject({ ...saved, observedCommitment: "confirmed", observedSlot: 1 });
      expect(String(saved.eventId)).toMatch(/^[0-9a-f]{64}$/); expect(restarted.state.snapshot().cursor).toBe("A");
      expect(w.chain.getTransaction).toHaveBeenCalledOnce();
    } finally { receiver.closeAllConnections(); await new Promise<void>(resolve => receiver.close(() => resolve())); }
  });
  it("recovers remaining alerts after a real process exits following one durable acknowledgment", async () => {
    const w = setup(), fixture = join(w.directory, "fixture.json");
    writeFileSync(fixture, JSON.stringify({ key: w.key.toString("hex"), scope: w.scope, path: w.path, pocket: pocket.toBase58() }));
    const module = pathToFileURL(join(process.cwd(), "dist/state.js")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs'; import { WatcherState } from ${JSON.stringify(module)};
      const f = JSON.parse(readFileSync(process.argv[1])); const db = new WatcherState(f.path, Buffer.from(f.key,'hex'), f.scope);
      db.begin(1); db.page(undefined,[{signature:'A',slot:1,err:null}],1000);
      const d=db.prepare(db.oldest(),[[f.pocket,'100']],[{subject:'first',body:{pocket:f.pocket}},{subject:'second',body:{pocket:f.pocket}}]);
      db.acknowledge(d.alerts[0].body.eventId); process.exit(23);
    `, fixture], { timeout: 5000, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(23); expect(() => w.open()).toThrow(/owned/);
    w.advance(120_000); const db = w.open(), remaining = db.delivery()!.alerts[1]!;
    const notify = vi.fn(async () => {}), watcher = w.watcher(db, { notify }); await watcher.tick();
    expect(notify).toHaveBeenCalledExactlyOnceWith(remaining.subject, remaining.body); expect(w.chain.getTransaction).not.toHaveBeenCalled();
    expect(db.snapshot().cursor).toBe("A"); expect(db.delivery()).toBeUndefined(); expect(watcher.pending.size).toBe(1);
  });
  it("fences stale acknowledgments and authenticates encrypted records against receiver scope", () => {
    const w = setup(), old = w.open(); old.begin(1); old.page(undefined, [info("A")], 1000);
    const delivery = old.prepare(old.oldest()!, [], [{ subject: "first", body: {} }]);
    w.advance(90_001); const replacement = w.open(); expect(() => old.acknowledge(String(delivery.alerts[0]!.body.eventId))).toThrow(/ownership/);
    const otherPath = join(w.directory, "other.sqlite"), other = w.open({ ...w.scope, receiver: "other" }, otherPath);
    other.begin(1); other.page(undefined, [info("A")], 1000); other.prepare(other.oldest()!, [], [{ subject: "other", body: {} }]);
    const a = new DatabaseSync(w.path), b = new DatabaseSync(otherPath);
    try { b.prepare("UPDATE state SET data=? WHERE name='delivery'").run(a.prepare("SELECT data FROM state WHERE name='delivery'").get()!.data!); }
    finally { a.close(); b.close(); }
    expect(() => other.delivery()).toThrow(); replacement.acknowledge(String(delivery.alerts[0]!.body.eventId)); replacement.complete("A");
  });
  it("refuses capacity overflow atomically and keeps readiness false on stale head and drain", async () => {
    const w = setup(), db = w.open(w.scope, w.path, 1);
    db.begin(1); expect(() => db.page(undefined, [info("B"), info("A")], 1000)).toThrow(/capacity/);
    expect(db.count()).toBe(0); expect(db.scan()?.before).toBeUndefined();
    const watcher = w.watcher(db); expect(watcher.ready()).toBe(false); await watcher.tick();
    // A restored scan has no fresh observed head until the next complete cycle.
    expect(watcher.ready()).toBe(false); await watcher.tick(); expect(watcher.ready()).toBe(true);
    watcher.status.lastHeadAdvancedAt = new Date(Date.now() - 31_000).toISOString(); expect(watcher.ready()).toBe(false);
    watcher.drain(); expect(watcher.ready()).toBe(false);
  });
});
