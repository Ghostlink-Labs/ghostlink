import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { EncryptedSqlite } from "@ghostlink/service-kit/storage";

export interface CrankScope { genesisHash: string; pocketProgram: string; payer: string }
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
  readonly maximumFee: number;
  readonly totalBudget: number;
  readonly maximumAttempts: number;
  constructor(path: string, key: Uint8Array, scope: CrankScope, limits: {
    maximumFeeLamports: number; totalBudgetLamports: number; maximumAttempts?: number;
  }) {
    this.scope = Object.freeze({ genesisHash: scope.genesisHash, pocketProgram: scope.pocketProgram, payer: scope.payer });
    for (const id of Object.values(this.scope)) if (new PublicKey(id).toBase58() !== id) throw new Error("invalid crank journal scope");
    this.maximumFee = limits.maximumFeeLamports; this.totalBudget = limits.totalBudgetLamports;
    this.maximumAttempts = limits.maximumAttempts ?? 3;
    for (const n of [this.maximumFee, this.totalBudget, this.maximumAttempts]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid crank budget");
    }
    if (this.maximumAttempts > 10 || this.maximumFee > this.totalBudget) throw new Error("invalid crank budget");
    const namespace = "ghostlink:watcher-crank:v1:" + createHash("sha256").update(JSON.stringify(this.scope)).digest("hex");
    this.#storage = new EncryptedSqlite(path, key, namespace);
    try {
      // Restoring old reservations could reset spending. No backup-import path is enabled for funded cranks.
      if (this.#storage.recoveryId) throw new Error("restored crank journal requires operator reconciliation");
      this.#storage.transaction(() => this.#storage.db.exec(
        "CREATE TABLE IF NOT EXISTS cranks (pocket TEXT PRIMARY KEY, record BLOB NOT NULL) STRICT;" +
        "CREATE TABLE IF NOT EXISTS spending (id INTEGER PRIMARY KEY CHECK(id=1), record BLOB NOT NULL) STRICT;"));
    } catch (e) { this.#storage.close(); throw e; }
  }
  close(): void { this.#storage.close(); }
  checkWritable(): void { this.#storage.checkWritable(); }
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
    if (!row) return 0;
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
