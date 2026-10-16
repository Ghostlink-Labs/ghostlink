/** Node-only encrypted local SQLite storage. Import via service-kit/storage. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, constants, mkdirSync, mkdtempSync, openSync, closeSync, readSync, writeFileSync, fstatSync, fsyncSync, unlinkSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const BACKUP_MAGIC = Buffer.from("GHOSTLINK-SQLITE-BACKUP-1\n");
// Bounded in-memory authentication: no unauthenticated plaintext is opened as SQLite.
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const backupAad = (namespace: string) => "ghostlink:sqlite-backup:v1:" + namespace;

function readBounded(path: string, maximum: number): Buffer {
  const fd = openSync(path, "r");
  let bytes: Buffer | undefined, success = false;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("backup exceeds 128 MiB limit or is not a regular file");
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw new Error("backup changed during read");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error("backup changed during read");
    success = true; return bytes;
  } finally { if (!success) bytes?.fill(0); closeSync(fd); }
}
function syncFile(path: string, mode = "r+"): void {
  const fd = openSync(path, mode);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void { if (process.platform !== "win32") syncFile(path, "r"); }
function unlinkOwned(path: string): void {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function decrypt(key: Uint8Array, value: Uint8Array, aad: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.length < 28) throw new Error("invalid encrypted record");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const plain = decipher.update(bytes.subarray(28));
  try { return Buffer.concat([plain, decipher.final()]); }
  finally { plain.fill(0); }
}

export class EncryptedSqlite {
  #db!: DatabaseSync;
  #key: Buffer;
  #namespace: string;
  #closed = false;

  constructor(path: string, encryptionKey: Uint8Array, namespace: string) {
    if (encryptionKey.length !== 32) throw new Error("storage requires a 32-byte encryption key");
    if (!namespace) throw new Error("storage namespace required");
    this.#key = Buffer.from(encryptionKey);
    this.#namespace = namespace;
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
  close(): void { try { if (!this.#closed) this.#db.close(); } finally { this.#closed = true; this.#key.fill(0); } }

  /** A new epoch on EVERY restore, even when restoring a backup of an earlier restore. */
  get recoveryId(): string | undefined {
    const row = this.#db.prepare("SELECT value FROM metadata WHERE name='restore-v1'").get();
    if (!row) return;
    const plain = this.open(row.value as Uint8Array, this.#namespace + ":restore:v1");
    try {
      const id = plain.toString();
      if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid restore epoch");
      return id;
    } finally { plain.fill(0); }
  }

  /** Consistent SQLite snapshot including committed WAL pages. Never overwrites an archive. */
  async backupTo(destination: string): Promise<void> {
    if (this.#closed) throw new Error("storage is closed");
    const temp = mkdtempSync(join(dirname(destination), ".ghostlink-backup-"));
    chmodSync(temp, 0o700);
    const snapshot = join(temp, "snapshot.sqlite");
    let plain: Buffer | undefined;
    try {
      closeSync(openSync(snapshot, "wx", 0o600));
      await backup(this.#db, snapshot);
      plain = readBounded(snapshot, MAX_BACKUP_BYTES);
      writeFileSync(destination, Buffer.concat([BACKUP_MAGIC, this.seal(plain, backupAad(this.#namespace))]), { flag: "wx", mode: 0o600, flush: true });
      syncDirectory(dirname(destination));
    } finally {
      plain?.fill(0);
      // Only our own newly created snapshot and directory, never caller-provided paths.
      for (const file of [snapshot, snapshot + "-journal", snapshot + "-wal", snapshot + "-shm"]) unlinkOwned(file);
      rmdirSync(temp);
    }
  }

  /** Restore only into a NEW directory. Consumers must enforce the authenticated recovery epoch. */
  static restoreBackup(archive: string, destinationDirectory: string, key: Uint8Array, namespace: string): string {
    if (key.length !== 32 || !namespace) throw new Error("invalid backup key or namespace");
    const sealed = readBounded(archive, MAX_BACKUP_BYTES + BACKUP_MAGIC.length + 28);
    if (!sealed.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error("invalid backup format");
    const plain = decrypt(key, sealed.subarray(BACKUP_MAGIC.length), backupAad(namespace));
    let created = false, opened: EncryptedSqlite | undefined;
    const temporary = join(destinationDirectory, ".restoring.sqlite"), destination = join(destinationDirectory, "state.sqlite");
    try {
      mkdirSync(destinationDirectory, { mode: 0o700 }); created = true;
      writeFileSync(temporary, plain, { flag: "wx", mode: 0o600, flush: true });
      opened = new EncryptedSqlite(temporary, key, namespace);
      const integrity = opened.db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") throw new Error("backup database failed integrity check");
      opened.transaction(() => opened!.db.prepare("INSERT INTO metadata VALUES ('restore-v1', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
        .run(opened!.seal(Buffer.from(randomBytes(32).toString("hex")), namespace + ":restore:v1")));
      opened.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
      opened.close(); opened = undefined;
      copyFileSync(temporary, destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
      syncFile(destination); syncDirectory(destinationDirectory); syncDirectory(dirname(destinationDirectory));
      return destination;
    } finally {
      plain.fill(0); opened?.close();
      if (created) {
        // Leave the new directory for inspection on failure; no recursive delete of operator paths.
        for (const file of [temporary, temporary + "-wal", temporary + "-shm", temporary + "-journal"]) {
          unlinkOwned(file);
        }
      }
    }
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  seal(secret: Uint8Array, aad: string): Buffer {
    if (this.#closed) throw new Error("storage is closed");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.concat([cipher.update(secret), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  }

  open(value: Uint8Array, aad: string): Buffer {
    if (this.#closed) throw new Error("storage is closed");
    return decrypt(this.#key, value, aad);
  }
}
