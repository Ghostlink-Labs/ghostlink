/** Node-only encrypted local SQLite storage. Import via service-kit/storage. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class EncryptedSqlite {
  #db!: DatabaseSync;
  #key: Buffer;

  constructor(path: string, encryptionKey: Uint8Array, namespace: string) {
    if (encryptionKey.length !== 32) throw new Error("storage requires a 32-byte encryption key");
    if (!namespace) throw new Error("storage namespace required");
    this.#key = Buffer.from(encryptionKey);
    try {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.#db = new DatabaseSync(path, { allowExtension: false });
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;`);
      this.transaction(() => {
        const row = this.#db.prepare("SELECT value FROM metadata WHERE name='key-check-v1'").get();
        const aad = namespace + ":key-check:v1", value = namespace + ":v1";
        if (row) {
          const check = this.open(row.value as Uint8Array, aad);
          try { if (check.toString() !== value) throw new Error("invalid database key or namespace"); }
          finally { check.fill(0); }
        } else this.#db.prepare("INSERT INTO metadata VALUES ('key-check-v1', ?)").run(this.seal(Buffer.from(value), aad));
      });
    } catch (error) { this.#db?.close(); this.#key.fill(0); throw error; }
  }

  get db(): DatabaseSync { return this.#db; }
  close(): void { try { this.#db.close(); } finally { this.#key.fill(0); } }

  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  seal(secret: Uint8Array, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.concat([cipher.update(secret), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  }

  open(value: Uint8Array, aad: string): Buffer {
    const bytes = Buffer.from(value);
    if (bytes.length < 28) throw new Error("invalid encrypted record");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  }
}
