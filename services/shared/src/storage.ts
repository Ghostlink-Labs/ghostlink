/** Node-only encrypted local SQLite storage. Import via service-kit/storage. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, constants, mkdirSync, mkdtempSync, openSync, closeSync, readSync, writeFileSync, fstatSync, fsyncSync, unlinkSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const BACKUP_MAGIC = Buffer.from("GHOSTLINK-SQLITE-BACKUP-1\n");
// Bounded in-memory authentication: no unauthenticated plaintext is opened as SQLite.
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const backupAad = (namespace: string) => "ghostlink:sqlite-backup:v1:" + namespace;

export interface EncryptedTable {
  name: string;
  /** Complete schema, so a future encrypted column cannot silently retain the old key. */
  columns: readonly string[];
  primaryKey: readonly string[];
  encrypted: Readonly<Record<string, (row: Record<string, unknown>) => string>>;
}
const identifier = (name: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("invalid storage schema identifier");
  return '"' + name + '"';
};

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
function encrypt(key: Uint8Array, secret: Uint8Array, aad: string): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
}

export class EncryptedSqlite {
  #db!: DatabaseSync;
  #key: Buffer;
  #namespace: string;
  #closed = false;
  #ready = false;
  #inTransaction = false;

  constructor(path: string, encryptionKey: Uint8Array, namespace: string, options: { existing?: boolean } = {}) {
    if (encryptionKey.length !== 32) throw new Error("storage requires a 32-byte encryption key");
    if (!namespace) throw new Error("storage namespace required");
    this.#key = Buffer.from(encryptionKey);
    this.#namespace = namespace;
    try {
      if (options.existing) {
        // Read-only SQLite open cannot create a missing file or initialize an
        // empty/mistyped database. Authenticate before any writable open.
        const existing = new DatabaseSync(path, { readOnly: true, allowExtension: false });
        try { this.#verifyKey(existing); } finally { existing.close(); }
      } else if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.#db = new DatabaseSync(path, { allowExtension: false });
      // Recheck on the actual writable handle: deletion/replacement between
      // opens must never cause a new sentinel/business state to be initialized.
      if (options.existing) this.#verifyKey();
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (!options.existing) this.#db.exec("CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;");
      this.transaction(() => {
        const row = this.#db.prepare("SELECT value FROM metadata WHERE name='key-check-v1'").get();
        const aad = namespace + ":key-check:v1", value = namespace + ":v1";
        if (row) {
          const check = this.open(row.value as Uint8Array, aad);
          try { if (check.toString() !== value) throw new Error("invalid database key or namespace"); }
          finally { check.fill(0); }
        } else {
          if (options.existing) throw new Error("existing storage key check is missing");
          this.#db.prepare("INSERT INTO metadata VALUES ('key-check-v1', ?)").run(this.seal(Buffer.from(value), aad));
        }
      });
      this.#ready = true;
    } catch (error) {
      try { this.close(); } catch { /* Preserve the original open/authentication failure. */ }
      throw error;
    }
  }

  #verifyKey(db = this.#db): void {
    if (this.#closed) throw new Error("storage is closed");
    const row = db.prepare("SELECT value FROM metadata WHERE name='key-check-v1'").get();
    if (!row) throw new Error("database key check is missing");
    let plain: Buffer | undefined;
    try {
      plain = decrypt(this.#key, row.value as Uint8Array, this.#namespace + ":key-check:v1");
      if (plain.toString() !== this.#namespace + ":v1") throw new Error("invalid key check");
    } catch { throw new Error("storage key changed or database authentication failed; reopen with the approved key"); }
    finally { plain?.fill(0); }
  }
  #checkCurrentKey(): void {
    if (this.#closed) throw new Error("storage is closed");
    if (this.#ready && !this.#inTransaction) this.#verifyKey();
  }
  get db(): DatabaseSync { this.#checkCurrentKey(); return this.#db; }
  /** Commit a fresh encryption of the existing sentinel; no business state changes. */
  checkWritable(): void {
    if (this.#closed || this.#inTransaction) throw new Error("storage probe unavailable");
    const timeout = Number(this.#db.prepare("PRAGMA busy_timeout").get()!.timeout);
    let failed = false;
    this.#db.exec("PRAGMA busy_timeout=0");
    try {
      this.transaction(() => {
        const plain = Buffer.from(this.#namespace + ":v1");
        try {
          this.#db.prepare("UPDATE metadata SET value=? WHERE name='key-check-v1'")
            .run(this.seal(plain, this.#namespace + ":key-check:v1"));
        } finally { plain.fill(0); }
      });
    } catch (e) { failed = true; throw e; }
    finally {
      if (!this.#closed) {
        try { this.#db.exec(`PRAGMA busy_timeout=${timeout}`); }
        catch (e) { try { this.close(); } catch { /* Preserve the primary failure. */ } if (!failed) throw e; }
      }
    }
  }
  close(): void { try { if (!this.#closed) this.#db?.close(); } finally { this.#closed = true; this.#key.fill(0); } }

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
    this.#checkCurrentKey();
    const temp = mkdtempSync(join(dirname(destination), ".ghostlink-backup-"));
    chmodSync(temp, 0o700);
    const snapshot = join(temp, "snapshot.sqlite");
    let plain: Buffer | undefined;
    try {
      closeSync(openSync(snapshot, "wx", 0o600));
      await backup(this.#db, snapshot);
      // Another connection can rotate while the asynchronous SQLite backup is running.
      // Never wrap new-key records in an archive encrypted by a stale connection's old key.
      const check = new DatabaseSync(snapshot, { readOnly: true, allowExtension: false });
      try { this.#verifyKey(check); } finally { check.close(); }
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
    if (this.#inTransaction) throw new Error("nested storage transaction");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#checkCurrentKey(); this.#inTransaction = true;
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("storage transaction callback must be synchronous");
      this.#db.exec("COMMIT"); return result;
    }
    catch (error) {
      try { this.#db.exec("ROLLBACK"); }
      catch {
        // SQLite can already have rolled back on an I/O/resource failure. Preserve that cause
        // and retire this connection rather than permitting work on an uncertain transaction.
        try { this.close(); } catch { /* The original failure remains the actionable error. */ }
      }
      throw error;
    }
    finally { this.#inTransaction = false; }
  }

  /** Atomic planned rotation on the same database. All other handles must reopen afterward. */
  rotateKey(nextKey: Uint8Array, tables: readonly EncryptedTable[], metadataAad: Readonly<Record<string, string>> = {}): void {
    if (nextKey.length !== 32 || Buffer.from(nextKey).equals(this.#key)) throw new Error("rotation requires a different 32-byte key");
    const replacement = Buffer.from(nextKey);
    let committed = false;
    try {
      this.transaction(() => {
        const expected = [...tables, { name: "metadata", columns: ["name", "value"], primaryKey: ["name"], encrypted: {
          value: (row: Record<string, unknown>) => {
            const name = String(row.name);
            if (name === "key-check-v1") return this.#namespace + ":key-check:v1";
            if (name === "restore-v1") return this.#namespace + ":restore:v1";
            if (Object.hasOwn(metadataAad, name)) return metadataAad[name]!;
            throw new Error("unrecognized encrypted metadata; rotation requires a schema update");
          },
        } }];
        const schema = this.#db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND type IN ('table','view','trigger')").all();
        if (schema.length !== expected.length || new Set(expected.map(t => t.name)).size !== expected.length ||
          schema.some(row => row.type !== "table" || !expected.some(t => t.name === row.name))) throw new Error("unrecognized storage schema; rotation refused");
        // Validate ALL schemas before changing anything. User callbacks supply AAD, never SQL.
        for (const table of expected) {
          const columns = this.#db.prepare(`PRAGMA table_xinfo(${identifier(table.name)})`).all();
          const primary = columns.filter(c => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(c => String(c.name));
          if (columns.length !== table.columns.length || columns.some(c => !table.columns.includes(String(c.name))) ||
            JSON.stringify(primary) !== JSON.stringify(table.primaryKey) || !primary.length ||
            Object.keys(table.encrypted).some(c => !table.columns.includes(c) || primary.includes(c))) throw new Error("unrecognized storage columns; rotation refused");
        }
        for (const table of expected) {
          const encrypted = Object.entries(table.encrypted);
          if (!encrypted.length) continue;
          const update = this.#db.prepare(`UPDATE ${identifier(table.name)} SET ${encrypted.map(([column]) => identifier(column) + "=?").join(",")} WHERE ${table.primaryKey.map(column => identifier(column) + "=?").join(" AND ")}`);
          for (const row of this.#db.prepare(`SELECT * FROM ${identifier(table.name)}`).all()) {
            const values = encrypted.map(([column, aadFor]) => {
              if (row[column] === null) return null;
              if (!(row[column] instanceof Uint8Array)) throw new Error("invalid encrypted storage column");
              const aad = aadFor(row), plain = this.open(row[column] as Uint8Array, aad);
              try { return encrypt(replacement, plain, aad); } finally { plain.fill(0); }
            });
            const keys = table.primaryKey.map(column => {
              if (typeof row[column] !== "string") throw new Error("invalid storage row identity");
              return row[column] as string;
            });
            if (Number(update.run(...values, ...keys).changes) !== 1) throw new Error("storage rotation lost a row");
          }
        }
      });
      committed = true;
      this.#key.fill(0); this.#key = replacement;
    } finally { if (!committed) replacement.fill(0); }
  }

  seal(secret: Uint8Array, aad: string): Buffer {
    this.#checkCurrentKey();
    return encrypt(this.#key, secret, aad);
  }

  open(value: Uint8Array, aad: string): Buffer {
    this.#checkCurrentKey();
    return decrypt(this.#key, value, aad);
  }
}
