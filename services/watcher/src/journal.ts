import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { EncryptedSqlite } from "@ghostlink/service-kit/storage";

export interface CrankScope { genesisHash: string; pocketProgram: string; payer: string }
export interface CrankLimits { maximumFeeLamports: number; totalBudgetLamports: number; maximumAttempts?: number }
export interface CrankPacket {
  rawBase64: string; signature: string; blockhash: string; lastValidBlockHeight: number; minContextSlot: number;
}
export interface CrankAttempt {
  pocket: string; proposal: string; packet: CrankPacket; fee: number; attempt: number;
  state: "pending" | "confirmed" | "finalized" | "failed" | "expired";
  observedSlot: number;
}
const terminal = (a: CrankAttempt) => ["finalized", "failed", "expired"].includes(a.state);

/** FULL SQLite commits bind the packet and cumulative fee reservation in one transaction. */
export class CrankJournal {
  readonly scope: Readonly<CrankScope>;
  #storage: EncryptedSqlite;
  #namespace: string;
  #openedInstanceId: string;
  readonly maximumFee: number;
  readonly totalBudget: number;
  readonly maximumAttempts: number;
  constructor(path: string, key: Uint8Array, scope: CrankScope, limits: CrankLimits, expectedId?: string) {
    this.scope = Object.freeze({ genesisHash: scope.genesisHash, pocketProgram: scope.pocketProgram, payer: scope.payer });
    for (const id of Object.values(this.scope)) if (new PublicKey(id).toBase58() !== id) throw new Error("invalid crank journal scope");
    this.maximumFee = limits.maximumFeeLamports; this.totalBudget = limits.totalBudgetLamports;
    this.maximumAttempts = limits.maximumAttempts ?? 3;
    for (const n of [this.maximumFee, this.totalBudget, this.maximumAttempts]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid crank budget");
    }
    if (this.maximumAttempts > 10 || this.maximumFee > this.totalBudget) throw new Error("invalid crank budget");
    this.#namespace = "ghostlink:watcher-crank:v1:" + createHash("sha256").update(JSON.stringify(this.scope)).digest("hex");
    this.#storage = new EncryptedSqlite(path, key, this.#namespace, { existing: expectedId !== undefined });
    try {
      // Restoring old reservations could reset spending. No backup-import path is enabled for funded cranks.
      if (this.#storage.recoveryId) throw new Error("restored crank journal requires operator reconciliation");
      this.#storage.transaction(() => {
        if (expectedId !== undefined) {
          this.#storage.db.prepare("SELECT pocket,record FROM cranks LIMIT 0").all();
          this.#storage.db.prepare("SELECT id,record FROM spending LIMIT 0").all();
        } else {
          this.#storage.db.exec("CREATE TABLE IF NOT EXISTS cranks (pocket TEXT PRIMARY KEY, record BLOB NOT NULL) STRICT;" +
            "CREATE TABLE IF NOT EXISTS spending (id INTEGER PRIMARY KEY CHECK(id=1), record BLOB NOT NULL) STRICT;");
          if (!this.instanceId) {
            if (!this.#storage.db.prepare("SELECT 1 FROM spending WHERE id=1").get()) {
              if (this.#storage.db.prepare("SELECT 1 FROM cranks LIMIT 1").get()) throw new Error("crank spending history is missing");
              this.#storage.db.prepare("INSERT INTO spending VALUES (1,?)").run(this.#encode(0, "spending"));
            }
            this.#storage.db.prepare("INSERT INTO metadata VALUES ('crank-instance-v1', ?)")
              .run(this.#storage.seal(Buffer.from(randomBytes(32).toString("hex")), this.#namespace + ":instance:v1"));
          }
        }
        const id = this.instanceId;
        if (!id || (expectedId !== undefined && id !== expectedId)) throw new Error("crank journal identity mismatch");
        this.spent(); // Authenticate the required cumulative record, including an explicit fresh zero.
      });
      this.#openedInstanceId = this.instanceId!;
    } catch (e) { this.#storage.close(); throw e; }
  }
  close(): void { this.#storage.close(); }
  checkWritable(): void { this.#assertIdentity(); this.spent(); this.#storage.checkWritable(); }
  get instanceId(): string | undefined {
    const row = this.#storage.db.prepare("SELECT value FROM metadata WHERE name='crank-instance-v1'").get();
    if (!row) return;
    const plain = this.#storage.open(row.value as Uint8Array, this.#namespace + ":instance:v1");
    try { const id = plain.toString(); if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid crank journal identity"); return id; }
    finally { plain.fill(0); }
  }
  static openExisting(path: string, key: Uint8Array, scope: CrankScope, limits: CrankLimits, expectedId: string): CrankJournal {
    if (typeof expectedId !== "string" || !/^[0-9a-f]{64}$/.test(expectedId)) throw new Error("expected crank journal identity required");
    return new CrankJournal(path, key, scope, limits, expectedId);
  }
  #assertIdentity(): void {
    if (this.instanceId !== this.#openedInstanceId || this.#storage.recoveryId) throw new Error("crank journal identity or restore state changed");
  }
  #aad(id: string): string { return JSON.stringify([this.scope, id]); }
  #decode<T>(bytes: Uint8Array, id: string): T {
    const plain = this.#storage.open(bytes, this.#aad(id));
    try { return JSON.parse(plain.toString()) as T; } finally { plain.fill(0); }
  }
  #encode(value: unknown, id: string): Uint8Array {
    const plain = Buffer.from(JSON.stringify(value));
    try { return this.#storage.seal(plain, this.#aad(id)); } finally { plain.fill(0); }
  }
  get(pocket: string): CrankAttempt | undefined {
    const row = this.#storage.db.prepare("SELECT record FROM cranks WHERE pocket=?").get(pocket);
    if (!row) return;
    const record = this.#decode<CrankAttempt>(row.record as Uint8Array, pocket);
    if (record.pocket !== pocket) throw new Error("crank journal identity mismatch");
    return record;
  }
  outstanding(): string[] {
    return this.#storage.db.prepare("SELECT pocket FROM cranks").all().map(row => String(row.pocket))
      .filter(pocket => !terminal(this.get(pocket)!));
  }
  spent(): number {
    const row = this.#storage.db.prepare("SELECT record FROM spending WHERE id=1").get();
    if (!row) throw new Error("crank cumulative spending record is missing");
    const value = this.#decode<number>(row.record as Uint8Array, "spending");
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid crank spending record");
    return value;
  }
  #write(record: CrankAttempt): void {
    this.#storage.db.prepare("INSERT INTO cranks VALUES (?,?) ON CONFLICT(pocket) DO UPDATE SET record=excluded.record")
      .run(record.pocket, this.#encode(record, record.pocket));
  }
  /** Competing preparations resolve to one packet, even across processes. No ambiguous-spend refunds. */
  prepare(pocket: string, proposal: string, packet: CrankPacket, fee: number): CrankAttempt {
    return this.#storage.transaction(() => {
      this.#assertIdentity(); this.spent();
      const prior = this.get(pocket);
      if (prior && (!terminal(prior) || (prior.proposal === proposal && prior.state !== "expired"))) return prior;
      const attempt = prior?.proposal === proposal ? prior.attempt + 1 : 1;
      if (attempt > this.maximumAttempts) throw new Error("crank attempt limit reached");
      if (prior && (packet.minContextSlot < prior.observedSlot || packet.signature === prior.packet.signature)) throw new Error("replacement crank packet is stale");
      if (!Number.isSafeInteger(fee) || fee < 1 || fee > this.maximumFee || fee > this.totalBudget - this.spent()) {
        throw new Error("crank fee budget exceeded");
      }
      const record: CrankAttempt = { pocket, proposal, packet: structuredClone(packet), fee, attempt,
        state: "pending", observedSlot: packet.minContextSlot };
      this.#storage.db.prepare("INSERT INTO spending VALUES (1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
        .run(this.#encode(this.spent() + fee, "spending"));
      this.#write(record);
      return record;
    });
  }
  observe(pocket: string, signature: string, state: CrankAttempt["state"], slot: number): CrankAttempt {
    return this.#storage.transaction(() => {
      this.#assertIdentity(); this.spent();
      const record = this.get(pocket);
      if (!record || record.packet.signature !== signature) throw new Error("crank attempt replaced");
      if (!Number.isSafeInteger(slot) || slot < record.observedSlot) throw new Error("stale crank observation");
      if (!terminal(record)) {
        // A concurrent or temporarily absent observation cannot re-enable a confirmed packet.
        if (record.state !== "confirmed" || state !== "pending") record.state = state;
        record.observedSlot = slot; this.#write(record);
      }
      return record;
    });
  }
}
