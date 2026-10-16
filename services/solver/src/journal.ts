import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { EncryptedSqlite } from "@ghostlink/service-kit/storage";
import type { IntentSubmission } from "@ghostlink/common";

export interface JournalScope { genesisHash: string; pocketProgram: string; solver: string }
export interface RecoveryAuthority { sessionKind: number; sessionKeyHex: string; maxSessionExpirySlot: string; slot: number }
export interface RecoverySession { sessionKind: 0 | 1; /** Account encoding: Ed25519 key + 00, or 33-byte P256 key. */ sessionKeyHex: string }
interface RecoveryPlan { baseline: RecoveryAuthority; expected: RecoverySession; finalizedSlot: number }
function journalNamespace(scope: JournalScope): string {
  for (const id of [scope.genesisHash, scope.pocketProgram, scope.solver]) {
    if (new PublicKey(id).toBase58() !== id) throw new Error("invalid journal deployment identity");
  }
  return "ghostlink:solver-journal:" + createHash("sha256").update(JSON.stringify({
    genesisHash: scope.genesisHash, pocketProgram: scope.pocketProgram, solver: scope.solver,
  })).digest("hex");
}
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
    this.#scope = Object.freeze({ genesisHash: scope.genesisHash, pocketProgram: scope.pocketProgram, solver: scope.solver });
    this.#storage = new EncryptedSqlite(path, key, journalNamespace(this.#scope));
    this.#clock = clock;
    try { this.#storage.transaction(() => {
      const hasContexts = this.#storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pocket_contexts'").get();
      this.#storage.db.exec(`CREATE TABLE IF NOT EXISTS pocket_recovery (epoch TEXT NOT NULL, pocket TEXT NOT NULL, record BLOB NOT NULL, PRIMARY KEY(epoch,pocket)) STRICT;
      CREATE TABLE IF NOT EXISTS pocket_contexts (pocket TEXT PRIMARY KEY, record BLOB NOT NULL) STRICT;
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
  backupTo(destination: string): Promise<void> { return this.#storage.backupTo(destination); }
  static restoreBackup(archive: string, newDirectory: string, key: Uint8Array, scope: JournalScope): string {
    return EncryptedSqlite.restoreBackup(archive, newDirectory, key, journalNamespace(scope));
  }
  get recoveryId(): string | undefined { return this.#storage.recoveryId; }

  #validateAuthority(authority: RecoveryAuthority): void {
    if (![0, 1].includes(authority.sessionKind) || !/^[0-9a-f]{66}$/.test(authority.sessionKeyHex) ||
      !/^(0|[1-9][0-9]{0,19})$/.test(authority.maxSessionExpirySlot) ||
      BigInt(authority.maxSessionExpirySlot) > 0xffffffffffffffffn || !Number.isSafeInteger(authority.slot) || authority.slot < 0) throw new Error("invalid recovery authority");
  }
  #recoveryAad(pocket: string): string { return JSON.stringify([this.#scope, "recovery-plan:v1", this.recoveryId, pocket]); }
  #recoveryPlan(pocket: string): RecoveryPlan | undefined {
    const row = this.#storage.db.prepare("SELECT record FROM pocket_recovery WHERE epoch=? AND pocket=?").get(this.recoveryId ?? "", pocket);
    if (!row) return;
    const plain = this.#storage.open(row.record as Uint8Array, this.#recoveryAad(pocket));
    try { return JSON.parse(plain.toString()) as RecoveryPlan; } finally { plain.fill(0); }
  }
  #saveRecovery(pocket: string, plan: RecoveryPlan): void {
    this.#storage.db.prepare("INSERT INTO pocket_recovery VALUES (?,?,?) ON CONFLICT(epoch,pocket) DO UPDATE SET record=excluded.record")
      .run(this.recoveryId!, pocket, this.#storage.seal(Buffer.from(JSON.stringify(plan)), this.#recoveryAad(pocket)));
  }
  recoverySlot(pocket: string): number | undefined {
    const plan = this.#recoveryPlan(pocket);
    return plan ? Math.max(plan.baseline.slot, plan.finalizedSlot) : undefined;
  }
  /** Trusted operator API: pin a freshly generated key BEFORE its owner installs it on chain. */
  prepareRecovery(pocket: string, authority: RecoveryAuthority, expected: RecoverySession): void {
    if (!this.recoveryId) throw new Error("journal was not restored");
    this.#validateAuthority(authority);
    if (![0, 1].includes(expected.sessionKind) || !/^[0-9a-f]{66}$/.test(expected.sessionKeyHex) ||
      (expected.sessionKind === 0 && !expected.sessionKeyHex.endsWith("00"))) throw new Error("invalid expected recovery key");
    this.#storage.transaction(() => {
      this.#advanceContext(pocket, authority.slot);
      const prior = this.#recoveryPlan(pocket);
      if (prior?.expected.sessionKind === expected.sessionKind && prior.expected.sessionKeyHex === expected.sessionKeyHex) return;
      if (authority.sessionKind === expected.sessionKind && authority.sessionKeyHex === expected.sessionKeyHex) throw new Error("recovery requires a different freshly generated key");
      this.#saveRecovery(pocket, { baseline: structuredClone(authority), expected: structuredClone(expected), finalizedSlot: prior?.finalizedSlot ?? 0 });
    });
  }
  /** Caller must verify finalized account ownership, layout, PDA and RPC genesis first. */
  recoveredAuthority(pocket: string, authority: RecoveryAuthority): boolean {
    if (!this.recoveryId) return true;
    this.#validateAuthority(authority);
    return this.#storage.transaction(() => {
      const plan = this.#recoveryPlan(pocket);
      if (!plan) return false;
      if (authority.slot < Math.max(plan.baseline.slot, plan.finalizedSlot)) throw new Error("finalized recovery context is stale");
      plan.finalizedSlot = authority.slot; this.#saveRecovery(pocket, plan);
      return authority.slot > plan.baseline.slot && BigInt(authority.maxSessionExpirySlot) > BigInt(plan.baseline.maxSessionExpirySlot) &&
        authority.sessionKind === plan.expected.sessionKind && authority.sessionKeyHex === plan.expected.sessionKeyHex;
    });
  }
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
