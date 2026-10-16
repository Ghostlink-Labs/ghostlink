import { EncryptedSqlite } from "@ghostlink/service-kit/storage";
import { isPocketNonceUsed } from "@ghostlink/service-kit";
import { bytesToHex, intentHash, policyHash } from "@ghostlink/common";
import { PublicKey } from "@solana/web3.js";
import { policyFromDto, type SignedIntent } from "@ghostlink/sdk";
import { createPublicKey, verify } from "node:crypto";
import type { BotConsent, ConsentStatus } from "./types.js";
import { consentHash, counter, decodeIntent, encodeIntent, orderScope, padded, U64_MAX, type StoredOrder, type BotIntentParams } from "./orders.js";

/** Local-disk SQLite; transactional across processes on the same machine. */
export class BotKeyStore {
  #storage: EncryptedSqlite;
  get #db() { return this.#storage.db; }

  constructor(path: string, encryptionKey: Uint8Array) {
    this.#storage = new EncryptedSqlite(path, encryptionKey, "ghostlink:bot-store");
    try { this.#transaction(() => {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS consent (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, user_id TEXT NOT NULL,
        request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        encrypted_key BLOB, state TEXT NOT NULL CHECK(state IN ('pending','confirmed','cancelled','expired')),
        expires_at INTEGER NOT NULL, confirmed_slot INTEGER,
        UNIQUE(bot_id, user_id, request_key)
      ) STRICT;`);
      // Existing consent databases are upgraded in place, without changing key envelopes.
      const columns = this.#db.prepare("PRAGMA table_info(consent)").all();
      if (!columns.some(c => c.name === "observed_slot")) this.#db.exec("ALTER TABLE consent ADD COLUMN observed_slot INTEGER NOT NULL DEFAULT 0");
      const hasContexts = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_contexts'").get();
      this.#db.exec(`CREATE TABLE IF NOT EXISTS bot_contexts (scope TEXT PRIMARY KEY, record BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS bot_orders (
        bot_id TEXT NOT NULL, user_id TEXT NOT NULL, request_key TEXT NOT NULL,
        scope TEXT NOT NULL, nonce TEXT NOT NULL, deadline TEXT NOT NULL, record BLOB NOT NULL,
        PRIMARY KEY(bot_id,user_id,request_key), UNIQUE(scope,nonce)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bot_counters (scope TEXT PRIMARY KEY, record BLOB NOT NULL) STRICT;`);
      if (!hasContexts) {
        for (const row of this.#db.prepare("SELECT payload, confirmed_slot, observed_slot FROM consent").all()) {
          const consent = JSON.parse(String(row.payload)) as BotConsent;
          const slot = Math.max(Number(row.confirmed_slot ?? 0), Number(row.observed_slot));
          this.#advanceContext(consent, Math.max(slot, this.authorizationSlot(consent)));
        }
      }
    }); } catch (error) { this.#storage.close(); throw error; }
  }

  close(): void { this.#storage.close(); }
  #transaction<T>(fn: () => T): T { return this.#storage.transaction(fn); }
  #encrypt(value: Uint8Array, aad: string): Buffer { return this.#storage.seal(value, aad); }
  #decrypt(value: Uint8Array, aad: string): Buffer { return this.#storage.open(value, aad); }
  #openJson<T>(value: Uint8Array, aad: string): T {
    const plain = this.#decrypt(value, aad);
    try { return JSON.parse(plain.toString()) as T; } finally { plain.fill(0); }
  }
  #sealJson(value: unknown, aad: string): Buffer {
    const plain = Buffer.from(JSON.stringify(value));
    try { return this.#encrypt(plain, aad); } finally { plain.fill(0); }
  }

  /** Confirmed account floor shared by all consent records for the same deployment/pocket. */
  authorizationSlot(c: BotConsent): number {
    const scope = orderScope(c), row = this.#db.prepare("SELECT record FROM bot_contexts WHERE scope=?").get(scope);
    if (!row) return 0;
    const slot = this.#openJson<number>(row.record as Uint8Array, "ghostlink:bot-authority:v1:" + scope);
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("invalid authorization context");
    return slot;
  }
  #advanceContext(c: BotConsent, slot: number): void {
    if (!Number.isSafeInteger(slot) || slot < this.authorizationSlot(c)) throw new Error("authorization context is stale");
    const scope = orderScope(c);
    this.#db.prepare("INSERT INTO bot_contexts VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET record=excluded.record")
      .run(scope, this.#sealJson(slot, "ghostlink:bot-authority:v1:" + scope));
  }

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
        this.#db.prepare("INSERT INTO consent (id,bot_id,user_id,request_key,fingerprint,payload,encrypted_key,state,expires_at,confirmed_slot) VALUES (?,?,?,?,?,?,?,'pending',?,NULL)").run(
          consent.id, botId, userId, requestKey, fingerprint, payload, encrypted, consent.expiresAt,
        );
        return { consent: JSON.parse(payload), state: "pending" };
      } finally { seed.fill(0); }
    });
  }

  read(id: string, botId: string, userId: string, now: number): ConsentStatus {
    this.#expire(now);
    const row = this.#db.prepare("SELECT payload, state, confirmed_slot, observed_slot FROM consent WHERE id=? AND bot_id=? AND user_id=?").get(id, botId, userId);
    if (!row) throw new Error("consent request not found");
    const consent = JSON.parse(String(row.payload)) as BotConsent;
    if (consent.id !== id || consent.botId !== botId || consent.userId !== userId) throw new Error("invalid stored consent identity");
    return { consent, state: row.state as ConsentStatus["state"], ...(row.confirmed_slot === null ? {} : { confirmedSlot: Number(row.confirmed_slot) }),
      ...(Number(row.observed_slot) === 0 ? {} : { observedSlot: Number(row.observed_slot) }) };
  }

  /** Record even a revoked account's context, so a later stale read cannot undo that observation. */
  observeSlot(id: string, botId: string, userId: string, now: number, slot: number): void {
    this.#transaction(() => {
      const current = this.read(id, botId, userId, now);
      if (!Number.isSafeInteger(slot) || slot < Math.max(current.confirmedSlot ?? 0, current.observedSlot ?? 0)) throw new Error("authorization context is stale");
      this.#advanceContext(current.consent, slot);
      this.#db.prepare("UPDATE consent SET observed_slot=? WHERE id=?").run(slot, id);
    });
  }

  assertActive(id: string, botId: string, userId: string, now: number, slot: number): BotConsent {
    const current = this.read(id, botId, userId, now);
    if (current.state !== "confirmed") throw new Error("bot session is not active locally");
    if (slot < Math.max(current.confirmedSlot ?? 0, current.observedSlot ?? 0, this.authorizationSlot(current.consent))) throw new Error("authorization context is stale");
    return current.consent;
  }

  confirm(id: string, botId: string, userId: string, now: number, slot: number): ConsentStatus {
    return this.#transaction(() => {
      const current = this.read(id, botId, userId, now);
      if (slot < Math.max(current.confirmedSlot ?? 0, current.observedSlot ?? 0)) throw new Error("authorization context is stale");
      this.#advanceContext(current.consent, slot);
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

  #orderAad(botId: string, userId: string, requestKey: string, scope: string, nonce: string, deadline: string): string {
    return JSON.stringify(["ghostlink:bot-order:v1", botId, userId, requestKey, scope, nonce, deadline]);
  }

  readOrder(consent: BotConsent, requestKey: string): StoredOrder | undefined {
    const row = this.#db.prepare("SELECT * FROM bot_orders WHERE bot_id=? AND user_id=? AND request_key=?")
      .get(consent.botId, consent.userId, requestKey);
    if (!row) return undefined;
    const aad = this.#orderAad(consent.botId, consent.userId, requestKey, String(row.scope), String(row.nonce), String(row.deadline));
    const order = this.#openJson<StoredOrder>(row.record as Uint8Array, aad);
    if (order.consentHash !== consentHash(consent) || order.consentId !== consent.id || order.requestKey !== requestKey ||
        String(row.scope) !== orderScope(consent) || counter(String(row.nonce)) !== BigInt(order.nonce) ||
        counter(String(row.deadline)) !== BigInt(order.intent.deadlineSlot) || order.intent.nonce !== order.nonce ||
        bytesToHex(intentHash(decodeIntent(order.intent))) !== order.intentHashHex) throw new Error("order request belongs to different consent or metadata");
    return order;
  }

  #saveOrder(c: BotConsent, order: StoredOrder): void {
    const scope = orderScope(c), nonce = padded(BigInt(order.nonce)), deadline = padded(BigInt(order.intent.deadlineSlot));
    const aad = this.#orderAad(c.botId, c.userId, order.requestKey, scope, nonce, deadline);
    this.#db.prepare(`INSERT INTO bot_orders VALUES (?,?,?,?,?,?,?) ON CONFLICT(bot_id,user_id,request_key)
      DO UPDATE SET record=excluded.record`).run(c.botId, c.userId, order.requestKey, scope, nonce, deadline,
        this.#sealJson(order, aad));
  }

  /** Synchronous transaction reserves before signing. All workers must use this same local database. */
  reserveOrder(c: BotConsent, requestKey: string, fingerprint: string, params: BotIntentParams,
    account: { nonceBase: bigint; nonceBitmap: Uint8Array }, slot: number, now: number, explicitNonce?: bigint): StoredOrder {
    return this.#transaction(() => {
      this.assertActive(c.id, c.botId, c.userId, now, slot);
      const prior = this.readOrder(c, requestKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("order request key was already used for different parameters");
        if (prior.state === "cancelled") throw new Error("order is cancelled locally");
        if (prior.state === "reserved" && isPocketNonceUsed(account, BigInt(prior.nonce))) throw new Error("reserved nonce is no longer usable; reconcile this order");
        return prior;
      }
      const scope = orderScope(c), aad = "ghostlink:bot-counter:v1:" + scope;
      const stored = this.#db.prepare("SELECT record FROM bot_counters WHERE scope=?").get(scope);
      const checkpoint = stored ? this.#openJson<{ next: string; live: { nonce: string; deadline: string }[] }>(stored.record as Uint8Array, aad)
        : { next: padded(0n), live: [] };
      if (!stored && this.#db.prepare("SELECT 1 FROM bot_orders WHERE scope=? LIMIT 1").get(scope)) throw new Error("missing nonce counter; restore a consistent database");
      let next = counter(checkpoint.next);
      const live = checkpoint.live.filter(o => { counter(o.nonce); return counter(o.deadline) >= BigInt(slot); });
      if (account.nonceBase > next) next = account.nonceBase;
      if (explicitNonce !== undefined) {
        if (explicitNonce < next || explicitNonce > U64_MAX) throw new Error("explicit nonce is already reserved or retired");
        next = explicitNonce;
      }
      while (next <= U64_MAX && isPocketNonceUsed(account, next)) {
        if (explicitNonce !== undefined) throw new Error("explicit nonce is already used");
        next++;
      }
      if (next > U64_MAX) throw new Error("pocket nonce space is exhausted");
      // Conservatively retain every issued nonce until its signed deadline, even if cancelled or confirmed.
      // Consumed bits alone cannot establish which intent succeeded, nor recall a released signature.
      if (live.some(o => next - counter(o.nonce) >= 2048n)) throw new Error("nonce window is full; wait for earlier order deadlines and reconcile outcomes");
      const intent = { ...params, pocket: new PublicKey(c.pocket).toBytes(), nonce: next, policyHash: policyHash(policyFromDto(c.policy)) };
      const order: StoredOrder = { requestKey, consentId: c.id, consentHash: consentHash(c), fingerprint,
        nonce: next.toString(), intentHashHex: bytesToHex(intentHash(intent)), intent: encodeIntent(intent), state: "reserved" };
      this.#saveOrder(c, order);
      live.push({ nonce: padded(next), deadline: padded(intent.deadlineSlot) });
      this.#db.prepare("INSERT INTO bot_counters VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET record=excluded.record")
        .run(scope, this.#sealJson({ next: padded(next + 1n), live }, aad));
      return order;
    });
  }

  saveSignedOrder(c: BotConsent, requestKey: string, signed: SignedIntent, slot: number, now: number): StoredOrder {
    return this.#transaction(() => {
      this.assertActive(c.id, c.botId, c.userId, now, slot);
      const order = this.readOrder(c, requestKey);
      if (!order || order.state === "cancelled") throw new Error("order is cancelled or missing");
      const hash = intentHash(signed.intent);
      const key = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(c.sessionKeyHex, "hex"),
      ]) });
      if (bytesToHex(hash) !== order.intentHashHex || bytesToHex(signed.hash) !== order.intentHashHex || signed.signature.webauthn ||
          !verify(null, hash, key, signed.signature.signature)) throw new Error("signed order does not match reserved intent");
      const signatureHex = bytesToHex(signed.signature.signature);
      if (order.signatureHex && order.signatureHex !== signatureHex) throw new Error("signed order changed");
      order.state = "signed"; order.signatureHex = signatureHex;
      this.#saveOrder(c, order);
      return order;
    });
  }

  cancelOrder(c: BotConsent, requestKey: string): StoredOrder {
    return this.#transaction(() => {
      const order = this.readOrder(c, requestKey);
      if (!order) throw new Error("order not found");
      order.state = "cancelled";
      this.#saveOrder(c, order);
      return order;
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
