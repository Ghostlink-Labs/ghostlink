import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { EncryptedSqlite } from "@ghostlink/service-kit/storage";
import type { IntentSubmission } from "@ghostlink/common";

export interface JournalScope { genesisHash: string; pocketProgram: string; solver: string }
export interface IntentIdentity { intentHashHex: string; pocket: string; nonce: string; sessionKind: 0 | 1; sessionKeyHex: string }
export interface PreparedTransaction {
  rawBase64: string; signature: string; blockhash: string;
  lastValidBlockHeight: number; minContextSlot: number;
}
export interface Attempt {
  identity: IntentIdentity;
  lease?: { token: string; until: number };
  transaction?: PreparedTransaction;
  observation: IntentSubmission;
  observedContext: number;
  /** Confirmed account-read context, separate from the processed signature-status context. */
  authorizationSlot?: number;
}

export class NonceConflictError extends Error {
  constructor() { super("nonce is reserved for a different intent or session"); this.name = "NonceConflictError"; }
}

/** Every intent owns its nonce permanently in this journal; a retry cannot become a new trade. */
export class SubmissionJournal {
  #storage: EncryptedSqlite;
  #scope: Readonly<JournalScope>;
  #clock: () => number;
  get scope(): Readonly<JournalScope> { return this.#scope; }

  constructor(path: string, key: Uint8Array, scope: JournalScope, clock = Date.now) {
    for (const id of [scope.genesisHash, scope.pocketProgram, scope.solver]) {
      if (new PublicKey(id).toBase58() !== id) throw new Error("invalid journal deployment identity");
    }
    this.#scope = Object.freeze({ genesisHash: scope.genesisHash, pocketProgram: scope.pocketProgram, solver: scope.solver });
    const binding = createHash("sha256").update(JSON.stringify(this.#scope)).digest("hex");
    this.#storage = new EncryptedSqlite(path, key, "ghostlink:solver-journal:" + binding);
    this.#clock = clock;
    try { this.#storage.transaction(() => {
      const hasContexts = this.#storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pocket_contexts'").get();
      this.#storage.db.exec(`CREATE TABLE IF NOT EXISTS pocket_contexts (pocket TEXT PRIMARY KEY, record BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, pocket TEXT NOT NULL, nonce TEXT NOT NULL, record BLOB NOT NULL,
      UNIQUE(pocket, nonce)
    ) STRICT;`);
      if (!hasContexts) for (const row of this.#storage.db.prepare("SELECT * FROM attempts").all()) {
        const record = this.#read(row)!;
        this.#advanceContext(record.identity.pocket, Math.max(this.authorizationSlot(record.identity.pocket),
          record.authorizationSlot ?? 0, record.transaction?.minContextSlot ?? 0));
      }
    }); } catch (error) { this.#storage.close(); throw error; }
  }

  close(): void { this.#storage.close(); }
  #contextAad(pocket: string): string { return JSON.stringify([this.#scope, "pocket-authority:v1", pocket]); }
  authorizationSlot(pocket: string): number {
    const row = this.#storage.db.prepare("SELECT record FROM pocket_contexts WHERE pocket=?").get(pocket);
    if (!row) return 0;
    const plain = this.#storage.open(row.record as Uint8Array, this.#contextAad(pocket));
    try {
      const slot = JSON.parse(plain.toString()) as number;
      if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("invalid authorization context");
      return slot;
    } finally { plain.fill(0); }
  }
  #advanceContext(pocket: string, slot: number): void {
    if (!Number.isSafeInteger(slot) || slot < this.authorizationSlot(pocket)) throw new Error("authorization context is stale");
    this.#storage.db.prepare("INSERT INTO pocket_contexts VALUES (?,?) ON CONFLICT(pocket) DO UPDATE SET record=excluded.record")
      .run(pocket, this.#storage.seal(Buffer.from(JSON.stringify(slot)), this.#contextAad(pocket)));
  }
  /** Call only after checking the account's program, layout and PDA, even when its session is refused. */
  observePocketContext(pocket: string, slot: number): void {
    this.#storage.transaction(() => this.#advanceContext(pocket, slot));
  }
  #aad(id: string, pocket: string, nonce: string): string { return JSON.stringify([this.#scope, id, pocket, nonce]); }
  #read(row: Record<string, unknown> | undefined): Attempt | undefined {
    if (!row) return;
    const plain = this.#storage.open(row.record as Uint8Array, this.#aad(String(row.id), String(row.pocket), String(row.nonce)));
    try {
      const record = JSON.parse(plain.toString()) as Attempt;
      if (record.identity.intentHashHex !== row.id || record.identity.pocket !== row.pocket || record.identity.nonce !== row.nonce) throw new Error("journal identity mismatch");
      return record;
    } finally { plain.fill(0); }
  }
  #write(record: Attempt): void {
    const i = record.identity;
    const plain = Buffer.from(JSON.stringify(record));
    try {
      const sealed = this.#storage.seal(plain, this.#aad(i.intentHashHex, i.pocket, i.nonce));
      this.#storage.db.prepare("INSERT INTO attempts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
        .run(i.intentHashHex, i.pocket, i.nonce, sealed);
    } finally { plain.fill(0); }
  }

  get(id: string): Attempt | undefined { return this.#read(this.#storage.db.prepare("SELECT * FROM attempts WHERE id=?").get(id)); }
  matching(identity: IntentIdentity): Attempt | undefined {
    const found = this.#read(this.#storage.db.prepare("SELECT * FROM attempts WHERE pocket=? AND nonce=?").get(identity.pocket, identity.nonce));
    if (found && (Object.keys(found.identity) as (keyof IntentIdentity)[]).some(key => found.identity[key] !== identity[key])) throw new NonceConflictError();
    return found;
  }

  claim(identity: IntentIdentity): { record: Attempt; token?: string } {
    return this.#storage.transaction(() => {
      const now = this.#clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid journal clock");
      const found = this.matching(identity);
      if (found?.transaction || (found?.lease && found.lease.until > now)) return { record: found };
      const token = randomBytes(32).toString("hex");
      const record: Attempt = { identity: structuredClone(identity), lease: { token, until: now + 30_000 },
        observation: { intentHashHex: identity.intentHashHex, state: "preparing" }, observedContext: 0,
        ...(found?.authorizationSlot === undefined ? {} : { authorizationSlot: found.authorizationSlot }) };
      this.#write(record);
      return { record, token };
    });
  }

  prepared(id: string, token: string, transaction: PreparedTransaction): Attempt {
    return this.#storage.transaction(() => {
      const record = this.get(id);
      if (!record || record.transaction || record.lease?.token !== token || record.lease.until <= this.#clock()) throw new Error("preparation lease lost; do not broadcast");
      if (transaction.minContextSlot < Math.max(record.authorizationSlot ?? 0, this.authorizationSlot(record.identity.pocket))) throw new Error("prepared authorization context is stale");
      record.transaction = structuredClone(transaction);
      delete record.lease;
      record.observation = { intentHashHex: id, state: "pending", signature: transaction.signature };
      record.observedContext = transaction.minContextSlot;
      this.#write(record); // Durable FULL commit happens before the caller can broadcast.
      return record;
    });
  }

  releasePreparation(id: string, token: string): void {
    this.#storage.transaction(() => {
      const record = this.get(id);
      if (record && !record.transaction && record.lease?.token === token) { delete record.lease; this.#write(record); }
    });
  }

  authorizedContext(id: string, slot: number): void {
    this.#storage.transaction(() => {
      const record = this.get(id);
      if (!record) return;
      if (!Number.isSafeInteger(slot) || slot < Math.max(record.authorizationSlot ?? 0, record.transaction?.minContextSlot ?? 0)) {
        throw new Error("authorization context is stale");
      }
      this.#advanceContext(record.identity.pocket, slot);
      record.authorizationSlot = slot; this.#write(record);
    });
  }

  observe(id: string, observation: IntentSubmission, context: number): Attempt {
    return this.#storage.transaction(() => {
      const record = this.get(id);
      if (!record?.transaction || observation.intentHashHex !== id || observation.signature !== record.transaction.signature) throw new Error("invalid journal observation");
      if (!Number.isSafeInteger(context) || context < record.observedContext) return record;
      if (record.observation.confirmationStatus === "finalized" || record.observation.state === "expired") return record;
      if (context === record.observedContext && record.observation.confirmationStatus && !observation.confirmationStatus) return record;
      record.observation = structuredClone(observation); record.observedContext = context;
      this.#write(record); return record;
    });
  }
}
