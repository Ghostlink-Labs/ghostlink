import { describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EncryptedSqlite } from "../src/storage.js";

describe("encrypted store compatibility", () => {
  it("opens authenticated existing state without initializing missing, empty or unauthenticated files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-existing-")), path = join(dir, "state.sqlite"), key = randomBytes(32);
    const open = () => new EncryptedSqlite(path, key, "existing", { existing: true });
    try {
      expect(open).toThrow(); expect(existsSync(path)).toBe(false);
      writeFileSync(path, ""); expect(open).toThrow(); expect(readFileSync(path).length).toBe(0);
      const empty = new DatabaseSync(path); empty.exec("CREATE TABLE unrelated (id INTEGER)"); empty.close();
      expect(open).toThrow();
      const check = new DatabaseSync(path, { readOnly: true });
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='metadata'").all()).toHaveLength(0); check.close();
      const created = new EncryptedSqlite(path, key, "existing"); created.close();
      const current = open(); current.checkWritable(); current.close();
      expect(() => new EncryptedSqlite(path, randomBytes(32), "existing", { existing: true })).toThrow();
      expect(() => new EncryptedSqlite(path, key, "different", { existing: true })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); key.fill(0); }
  });
  it("probes committed writes without changing records and detects read-only storage or stale keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-write-probe-")), path = join(dir, "store.sqlite");
    const key = randomBytes(32), replacement = randomBytes(32);
    const first = new EncryptedSqlite(path, key, "probe"), other = new EncryptedSqlite(path, key, "probe");
    try {
      const before = first.db.prepare("SELECT value FROM metadata WHERE name='key-check-v1'").get()!.value;
      first.checkWritable(); other.checkWritable();
      const after = first.db.prepare("SELECT value FROM metadata WHERE name='key-check-v1'").get()!.value;
      expect(after).not.toEqual(before);
      const blocker = new DatabaseSync(path);
      try {
        blocker.exec("BEGIN IMMEDIATE");
        const started = performance.now();
        expect(() => first.checkWritable()).toThrow(/locked/);
        expect(performance.now() - started).toBeLessThan(500);
      } finally { blocker.exec("ROLLBACK"); blocker.close(); }
      expect(first.db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(5000);
      first.db.exec("PRAGMA query_only=ON");
      expect(() => first.checkWritable()).toThrow(/readonly/i);
      first.db.exec("PRAGMA query_only=OFF"); first.checkWritable();
      other.rotateKey(replacement, []);
      expect(() => first.checkWritable()).toThrow(/key changed/);
      other.checkWritable();
    } finally { first.close(); other.close(); key.fill(0); replacement.fill(0); rmSync(dir, { recursive: true, force: true }); }
  });
  it("opens the existing bot store envelope and refuses namespace or AAD substitution", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-storage-test-")), path = join(dir, "old.sqlite"), key = randomBytes(32);
    const sealOld = (text: string, aad: string) => {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    };
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE metadata (name TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT");
    db.prepare("INSERT INTO metadata VALUES ('key-check-v1', ?)").run(sealOld("ghostlink:bot-store:v1", "ghostlink:bot-store:key-check:v1"));
    db.close();
    let store: EncryptedSqlite | undefined;
    try {
      store = new EncryptedSqlite(path, key, "ghostlink:bot-store");
      const old = sealOld("known secret fixture", "immutable consent");
      expect(store.open(old, "immutable consent").toString()).toBe("known secret fixture");
      expect(() => store!.open(old, "other consent")).toThrow();
      expect(() => new EncryptedSqlite(path, key, "other-purpose")).toThrow();
      expect(JSON.stringify(store)).toBe("{}");
    } finally { store?.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); }
  });
});
