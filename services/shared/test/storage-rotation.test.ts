import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedSqlite, type EncryptedTable } from "../src/storage.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.reverse()) fn(); cleanup.length = 0; });
const tables: EncryptedTable[] = [{ name: "records", columns: ["id", "payload"], primaryKey: ["id"],
  encrypted: { payload: row => "record:" + String(row.id) } }];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-rotation-test-")), path = join(dir, "state.sqlite");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32), next = randomBytes(32);
  const open = (secret = key, file = path) => {
    const store = new EncryptedSqlite(file, secret, "test:rotation"); cleanup.push(() => store.close()); return store;
  };
  const live = open();
  live.db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, payload BLOB NOT NULL) STRICT");
  for (const id of ["one", "two"]) live.db.prepare("INSERT INTO records VALUES (?,?)").run(id, live.seal(Buffer.from("secret " + id), "record:" + id));
  const read = (store: EncryptedSqlite, id: string) => store.open(store.db.prepare("SELECT payload FROM records WHERE id=?").get(id)!.payload as Uint8Array, "record:" + id).toString();
  return { dir, path, key, next, open, live, read };
}

describe("atomic storage key rotation", () => {
  it("re-encrypts records and recovery metadata, fences stale handles, and keeps archives bound to their original keys", async () => {
    const w = fixture(), stale = w.open(), archive = join(w.dir, "before.enc");
    await w.live.backupTo(archive);
    const restorePath = EncryptedSqlite.restoreBackup(archive, join(w.dir, "restored"), w.key, "test:rotation");
    const restored = w.open(w.key, restorePath), epoch = restored.recoveryId;
    restored.rotateKey(w.next, tables);
    expect(w.open(w.next, restorePath).recoveryId).toBe(epoch);
    expect(w.read(restored, "one")).toBe("secret one");
    w.live.rotateKey(w.next, tables);
    expect(w.read(w.open(w.next), "two")).toBe("secret two");
    expect(() => w.open()).toThrow();
    expect(() => stale.transaction(() => stale.db.exec("DELETE FROM records"))).toThrow(/key changed/);
    expect(() => stale.seal(Buffer.from("new"), "record:three")).toThrow(/key changed/);
    expect(() => w.live.rotateKey(w.next, tables)).toThrow(/different/);
    const after = join(w.dir, "after.enc"); await w.live.backupTo(after);
    expect(() => EncryptedSqlite.restoreBackup(after, join(w.dir, "wrong"), w.key, "test:rotation")).toThrow();
    const afterPath = EncryptedSqlite.restoreBackup(after, join(w.dir, "after"), w.next, "test:rotation");
    expect(w.read(w.open(w.next, afterPath), "two")).toBe("secret two");
    expect(() => EncryptedSqlite.restoreBackup(archive, join(w.dir, "wrong-old"), w.next, "test:rotation")).toThrow();
  });

  it("rolls back every changed row on authentication failure and refuses unrecognized schemas", () => {
    const w = fixture();
    const before = w.live.db.prepare("SELECT * FROM records ORDER BY id").all();
    const damaged = Buffer.from(before[1]!.payload as Uint8Array); damaged[0]! ^= 1;
    w.live.db.prepare("UPDATE records SET payload=? WHERE id='two'").run(damaged);
    expect(() => w.live.rotateKey(w.next, tables)).toThrow();
    expect(w.live.db.prepare("SELECT payload FROM records WHERE id='one'").get()!.payload).toEqual(before[0]!.payload);
    expect(w.read(w.open(), "one")).toBe("secret one");
    expect(() => w.open(w.next)).toThrow();
    w.live.db.prepare("UPDATE records SET payload=? WHERE id='two'").run(before[1]!.payload as Uint8Array);
    w.live.db.exec("ALTER TABLE records ADD COLUMN future_secret BLOB");
    expect(() => w.live.rotateKey(w.next, tables)).toThrow(/columns/);
    w.live.db.exec("ALTER TABLE records DROP COLUMN future_secret; CREATE TABLE future_records (id TEXT) STRICT");
    expect(() => w.live.rotateKey(w.next, tables)).toThrow(/schema/);
    w.live.db.exec("DROP TABLE future_records");
    // LIKE's underscore wildcard must not hide a user table that resembles SQLite's prefix.
    w.live.db.exec("CREATE TABLE sqlitex_records (id TEXT PRIMARY KEY, payload BLOB) STRICT");
    expect(() => w.live.rotateKey(w.next, tables)).toThrow(/schema/);
    w.live.db.exec("DROP TABLE sqlitex_records");
    w.live.db.exec("ALTER TABLE records ADD COLUMN future_derived BLOB GENERATED ALWAYS AS (payload) VIRTUAL");
    expect(() => w.live.rotateKey(w.next, tables)).toThrow(/columns/);
    w.live.db.exec("ALTER TABLE records DROP COLUMN future_derived");
    w.live.db.prepare("INSERT INTO metadata VALUES ('unknown-key',?)").run(w.live.seal(Buffer.from("extra"), "future:aad"));
    expect(() => w.live.rotateKey(w.next, tables)).toThrow(/metadata/);
    expect(w.read(w.open(), "two")).toBe("secret two");
  });

  it("preserves the original failure when SQLite already rolled back a transaction", () => {
    const w = fixture();
    w.live.db.exec("CREATE TRIGGER reject_write BEFORE INSERT ON records BEGIN SELECT RAISE(ROLLBACK, 'fixture storage refusal'); END");
    expect(() => w.live.transaction(() => {
      w.live.db.exec("DELETE FROM records WHERE id='one'");
      w.live.db.prepare("INSERT INTO records VALUES (?,?)").run("three", w.live.seal(Buffer.from("secret"), "record:three"));
    })).toThrow(/fixture storage refusal/);
    expect(() => w.live.db).toThrow(/closed/);
    expect(w.read(w.open(), "one")).toBe("secret one");
  });

  it("recovers the complete old-key database after a process exits midway through re-encryption", () => {
    const w = fixture();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { EncryptedSqlite } from ${JSON.stringify(new URL("../dist/storage.js", import.meta.url).href)};
      const p = JSON.parse(readFileSync(0, 'utf8'));
      const store = new EncryptedSqlite(p.path, Buffer.from(p.key, 'hex'), 'test:rotation');
      let seen = 0;
      store.rotateKey(Buffer.from(p.next, 'hex'), [{ name: 'records', columns: ['id','payload'], primaryKey: ['id'],
        encrypted: { payload: row => { if (++seen === 2) process.exit(23); return 'record:' + row.id; } } }]);
    `], { input: JSON.stringify({ path: w.path, key: w.key.toString("hex"), next: w.next.toString("hex") }), encoding: "utf8", timeout: 15_000 });
    expect(child.status, child.stderr).toBe(23);
    const reopened = w.open();
    expect(w.read(reopened, "one")).toBe("secret one"); expect(w.read(reopened, "two")).toBe("secret two");
    expect(() => w.open(w.next)).toThrow();
    reopened.rotateKey(w.next, tables);
    expect(w.read(w.open(w.next), "two")).toBe("secret two");
  });

  it("does not publish an archive that mixes pre-rotation encryption with post-rotation records", async () => {
    const w = fixture(), other = w.open(), destination = join(w.dir, "racing.enc");
    const pending = w.live.backupTo(destination);
    other.rotateKey(w.next, tables);
    await expect(pending).rejects.toThrow(/key changed/);
    expect(existsSync(destination)).toBe(false);
    await other.backupTo(destination);
    const restored = EncryptedSqlite.restoreBackup(destination, join(w.dir, "restored"), w.next, "test:rotation");
    expect(w.read(w.open(w.next, restored), "one")).toBe("secret one");
  });
});
