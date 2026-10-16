import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedSqlite } from "../src/storage.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.reverse()) fn(); cleanup.length = 0; });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-backup-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32), namespace = "test:backup", path = join(dir, "live.sqlite"), archive = join(dir, "backup.enc");
  const open = (file: string) => {
    const store = new EncryptedSqlite(file, key, namespace); cleanup.push(() => store.close()); return store;
  };
  const live = open(path);
  live.db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE facts (value TEXT) STRICT");
  live.db.prepare("INSERT INTO facts VALUES (?)").run("committed but still in WAL");
  return { dir, path, archive, key, namespace, live, open };
}

describe("authenticated SQLite backups", () => {
  it("backs up committed WAL data, isolates later writes, and restores under a fresh durable epoch", async () => {
    const w = fixture();
    expect(statSync(w.path + "-wal").size).toBeGreaterThan(0);
    await w.live.backupTo(w.archive);
    expect(readFileSync(w.archive).includes(Buffer.from("committed but still in WAL"))).toBe(false);
    expect(readFileSync(w.archive).includes(w.key)).toBe(false);
    w.live.db.exec("INSERT INTO facts VALUES ('after backup')");
    const restoredPath = EncryptedSqlite.restoreBackup(w.archive, join(w.dir, "restore"), w.key, w.namespace);
    const restored = w.open(restoredPath);
    expect(restored.db.prepare("SELECT value FROM facts").all()).toEqual([{ value: "committed but still in WAL" }]);
    expect(w.live.recoveryId).toBeUndefined();
    expect(restored.recoveryId).toMatch(/^[0-9a-f]{64}$/);
    expect(w.open(restoredPath).recoveryId).toBe(restored.recoveryId);
    const secondArchive = join(w.dir, "second.enc"); await restored.backupTo(secondArchive);
    const twice = w.open(EncryptedSqlite.restoreBackup(secondArchive, join(w.dir, "twice"), w.key, w.namespace));
    expect(twice.recoveryId).not.toBe(restored.recoveryId);
    expect(readdirSync(w.dir).some(file => file.startsWith(".ghostlink-backup-"))).toBe(false);
  });

  it("refuses wrong keys, scope substitutions, truncation and tampering before creating a database", async () => {
    const w = fixture(); await w.live.backupTo(w.archive);
    const target = join(w.dir, "restore");
    expect(() => EncryptedSqlite.restoreBackup(w.archive, target, randomBytes(32), w.namespace)).toThrow();
    expect(() => EncryptedSqlite.restoreBackup(w.archive, target, w.key, "other:namespace")).toThrow();
    const original = readFileSync(w.archive);
    for (const offset of [0, 30, original.length - 1]) {
      const damaged = Buffer.from(original); damaged[offset]! ^= 1;
      const file = join(w.dir, "corrupt.enc"); writeFileSync(file, damaged);
      expect(() => EncryptedSqlite.restoreBackup(file, target, w.key, w.namespace)).toThrow();
    }
    writeFileSync(join(w.dir, "short.enc"), original.subarray(0, original.length - 100));
    expect(() => EncryptedSqlite.restoreBackup(join(w.dir, "short.enc"), target, w.key, w.namespace)).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it("never overwrites a prior archive or an existing restore directory", async () => {
    const w = fixture(); await w.live.backupTo(w.archive);
    const bytes = readFileSync(w.archive);
    await expect(w.live.backupTo(w.archive)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(w.archive)).toEqual(bytes);
    const path = EncryptedSqlite.restoreBackup(w.archive, join(w.dir, "restore"), w.key, w.namespace);
    const restored = w.open(path); restored.db.exec("INSERT INTO facts VALUES ('keep me')");
    expect(() => EncryptedSqlite.restoreBackup(w.archive, join(w.dir, "restore"), w.key, w.namespace)).toThrow(/EEXIST/);
    expect(restored.db.prepare("SELECT count(*) AS n FROM facts").get()?.n).toBe(2);
  });

  it("refuses oversized archives without opening SQLite or allocating the claimed payload", () => {
    const w = fixture(), archive = join(w.dir, "oversized.enc"), target = join(w.dir, "restore");
    const fd = openSync(archive, "wx");
    try { ftruncateSync(fd, 129 * 1024 * 1024); } finally { closeSync(fd); }
    expect(() => EncryptedSqlite.restoreBackup(archive, target, w.key, w.namespace)).toThrow(/128 MiB/);
    expect(existsSync(target)).toBe(false);
  });
});
