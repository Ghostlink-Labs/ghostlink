import { EncryptedSqlite } from "@ghostlink/service-kit/storage";
import type { BotConsent, ConsentStatus } from "./types.js";

/** Local-disk SQLite; transactional across processes on the same machine. */
export class BotKeyStore {
  #storage: EncryptedSqlite;
  get #db() { return this.#storage.db; }

  constructor(path: string, encryptionKey: Uint8Array) {
    this.#storage = new EncryptedSqlite(path, encryptionKey, "ghostlink:bot-store");
    try {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS consent (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, user_id TEXT NOT NULL,
        request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        encrypted_key BLOB, state TEXT NOT NULL CHECK(state IN ('pending','confirmed','cancelled','expired')),
        expires_at INTEGER NOT NULL, confirmed_slot INTEGER,
        UNIQUE(bot_id, user_id, request_key)
      ) STRICT;`);
    } catch (error) { this.#storage.close(); throw error; }
  }

  close(): void { this.#storage.close(); }
  #transaction<T>(fn: () => T): T { return this.#storage.transaction(fn); }
  #encrypt(value: Uint8Array, aad: string): Buffer { return this.#storage.seal(value, aad); }
  #decrypt(value: Uint8Array, aad: string): Buffer { return this.#storage.open(value, aad); }

  #expire(now: number): void {
    this.#db.prepare("UPDATE consent SET state='expired', encrypted_key=NULL WHERE state='pending' AND expires_at<=?").run(now);
  }

  /** Same request key + same input returns the original key, including after a crash. */
  create(botId: string, userId: string, requestKey: string, fingerprint: string, now: number,
    make: () => { consent: BotConsent; seed: Uint8Array }): ConsentStatus {
    return this.#transaction(() => {
      this.#expire(now);
      const prior = this.#db.prepare("SELECT id, fingerprint FROM consent WHERE bot_id=? AND user_id=? AND request_key=?").get(botId, userId, requestKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("request key was already used for different permissions");
        return this.read(String(prior.id), botId, userId, now);
      }
      const count = this.#db.prepare("SELECT count(*) AS n FROM consent WHERE bot_id=? AND user_id=? AND state='pending'").get(botId, userId);
      if (Number(count?.n) >= 3) throw new Error("too many pending consent requests");
      const { consent, seed } = make();
      try {
        const payload = JSON.stringify(consent);
        const encrypted = this.#encrypt(seed, payload);
        this.#db.prepare("INSERT INTO consent VALUES (?,?,?,?,?,?,?,'pending',?,NULL)").run(
          consent.id, botId, userId, requestKey, fingerprint, payload, encrypted, consent.expiresAt,
        );
        return { consent: JSON.parse(payload), state: "pending" };
      } finally { seed.fill(0); }
    });
  }

  read(id: string, botId: string, userId: string, now: number): ConsentStatus {
    this.#expire(now);
    const row = this.#db.prepare("SELECT payload, state, confirmed_slot FROM consent WHERE id=? AND bot_id=? AND user_id=?").get(id, botId, userId);
    if (!row) throw new Error("consent request not found");
    const consent = JSON.parse(String(row.payload)) as BotConsent;
    if (consent.id !== id || consent.botId !== botId || consent.userId !== userId) throw new Error("invalid stored consent identity");
    return { consent, state: row.state as ConsentStatus["state"], ...(row.confirmed_slot === null ? {} : { confirmedSlot: Number(row.confirmed_slot) }) };
  }

  confirm(id: string, botId: string, userId: string, now: number, slot: number): ConsentStatus {
    return this.#transaction(() => {
      const current = this.read(id, botId, userId, now);
      if (current.state === "confirmed") return current;
      if (current.state !== "pending") throw new Error("consent request is no longer pending");
      this.#db.prepare("UPDATE consent SET state='confirmed', confirmed_slot=? WHERE id=? AND state='pending'").run(slot, id);
      return { ...current, state: "confirmed", confirmedSlot: slot };
    });
  }

  cancel(id: string, botId: string, userId: string, now: number): ConsentStatus {
    return this.#transaction(() => {
      const current = this.read(id, botId, userId, now);
      if (current.state === "expired") return current;
      this.#db.prepare("UPDATE consent SET state='cancelled', encrypted_key=NULL WHERE id=?").run(id);
      return { ...current, state: "cancelled" };
    });
  }

  /** Backend-only; never serialize or expose this method through HTTP. */
  async withSeed<T>(id: string, botId: string, userId: string, use: (seed: Uint8Array) => Promise<T>): Promise<T> {
    const row = this.#db.prepare("SELECT payload, encrypted_key FROM consent WHERE id=? AND bot_id=? AND user_id=? AND state='confirmed'").get(id, botId, userId);
    if (!row?.encrypted_key) throw new Error("bot session is not active locally");
    const seed = this.#decrypt(row.encrypted_key as Uint8Array, String(row.payload));
    try { return await use(seed); } finally { seed.fill(0); }
  }
}
