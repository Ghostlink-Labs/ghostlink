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
    try { this.#storage.db.exec(`CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, pocket TEXT NOT NULL, nonce TEXT NOT NULL, record BLOB NOT NULL,
      UNIQUE(pocket, nonce)
    ) STRICT;`); } catch (error) { this.#storage.close(); throw error; }
  }

  close(): void { this.#storage.close(); }
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
        observation: { intentHashHex: identity.intentHashHex, state: "preparing" }, observedContext: 0 };
      this.#write(record);
      return { record, token };
    });
  }

  prepared(id: string, token: string, transaction: PreparedTransaction): Attempt {
    return this.#storage.transaction(() => {
      const record = this.get(id);
      if (!record || record.transaction || record.lease?.token !== token || record.lease.until <= this.#clock()) throw new Error("preparation lease lost; do not broadcast");
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
