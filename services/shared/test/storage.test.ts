import { describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EncryptedSqlite } from "../src/storage.js";

describe("encrypted store compatibility", () => {
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
