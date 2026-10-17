import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { HttpError } from "@ghostlink/service-kit";
import { EncryptedSqlite } from "@ghostlink/service-kit/storage";
import type { RelayerReceipt } from "@ghostlink/common";
export type { RelayerReceipt };

export interface RelayerScope { genesisHash: string; payer: string; pocket: string; registry: string; census: string }
export interface RelayerPacket {
  rawBase64: string; signature: string; blockhash: string; lastValidBlockHeight: number; minContextSlot: number;
  feeLamports: string; rentLamports: string; tokenPairs?: RelayerReceipt["tokenPairs"];
}
export interface RelayerRecord {
  id: string; digest: string; lease?: { token: string; until: number }; packet?: RelayerPacket;
  chargedAt?: number; observation: RelayerReceipt; observedSlot: number;
}
export interface FundingEvidence { balanceLamports: bigint; slot: number; minimumReserveLamports: bigint }
const hex32 = (s: string) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
function journalNamespace(scope: RelayerScope): string {
  const ordered = { genesisHash: scope.genesisHash, payer: scope.payer, pocket: scope.pocket, registry: scope.registry, census: scope.census };
  for (const id of Object.values(ordered)) if (typeof id !== "string" || new PublicKey(id).toBase58() !== id) throw new Error("invalid relayer scope");
  return "ghostlink:relayer:v1:" + createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export class RelayerJournal {
  readonly scope: Readonly<RelayerScope>;
  readonly dailyBudget: bigint;
  #storage: EncryptedSqlite;
  #openedInstanceId?: string;
  constructor(path: string, key: Uint8Array, scope: RelayerScope, dailyBudget = 2_000_000_000n,
    private readonly clock = Date.now, private readonly maximumRecords = 10_000,
    private readonly mode: "active" | "maintenance" = "active", existing = false) {
    this.scope = Object.freeze({ genesisHash: scope.genesisHash, payer: scope.payer, pocket: scope.pocket, registry: scope.registry, census: scope.census }); this.dailyBudget = dailyBudget;
    if (dailyBudget < 0n || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1) throw new Error("invalid relayer journal limits");
    if (mode !== "active" && mode !== "maintenance") throw new Error("invalid relayer journal mode");
    const namespace = journalNamespace(this.scope);
    this.#storage = new EncryptedSqlite(path, key, namespace, { existing });
    try {
      if (this.#storage.recoveryId && mode !== "maintenance") throw new Error("restored relayer journal requires operator reconciliation");
      if (existing) this.#storage.db.prepare("SELECT id,record FROM operations LIMIT 0").all();
      else this.#storage.transaction(() => {
        this.#storage.db.exec("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, record BLOB NOT NULL) STRICT");
        if (!this.instanceId) this.#storage.db.prepare("INSERT INTO metadata VALUES ('relayer-instance-v1', ?)")
          .run(this.#storage.seal(Buffer.from(randomBytes(32).toString("hex")), this.#instanceAad()));
      });
      this.#openedInstanceId = this.instanceId;
      if (mode === "active" && !this.#openedInstanceId) throw new Error("relayer journal identity missing; reconcile legacy state before cutover");
    } catch (e) { this.#storage.close(); throw e; }
  }
  close(): void { this.#storage.close(); }
  checkWritable(): void { this.#storage.checkWritable(); }
  get recoveryId(): string | undefined { return this.#storage.recoveryId; }
  #instanceAad(): string { return journalNamespace(this.scope) + ":instance:v1"; }
  get instanceId(): string | undefined {
    const row = this.#storage.db.prepare("SELECT value FROM metadata WHERE name='relayer-instance-v1'").get();
    if (!row) return;
    const plain = this.#storage.open(row.value as Uint8Array, this.#instanceAad());
    try { const id = plain.toString(); if (!hex32(id)) throw new Error("invalid relayer journal identity"); return id; }
    finally { plain.fill(0); }
  }
  /** Hosted opening: authenticate existing state and match its independently pinned identity. */
  static openExisting(path: string, key: Uint8Array, scope: RelayerScope, expectedId: string, dailyBudget = 2_000_000_000n): RelayerJournal {
    if (!hex32(expectedId)) throw new Error("expected relayer journal identity required");
    const journal = new RelayerJournal(path, key, scope, dailyBudget, Date.now, 10_000, "active", true);
    if (journal.instanceId !== expectedId) { journal.close(); throw new Error("relayer journal identity mismatch"); }
    return journal;
  }
  /** Observation/backup/rotation only. There is deliberately no resume or clear-restore API. */
  static openForMaintenance(path: string, key: Uint8Array, scope: RelayerScope): RelayerJournal {
    return new RelayerJournal(path, key, scope, 2_000_000_000n, Date.now, 10_000, "maintenance", true);
  }
  assertSubmissionAllowed(): void {
    if (this.mode !== "active" || this.recoveryId) throw new Error("relayer maintenance/restore forbids paid submissions");
    if (!this.#openedInstanceId || this.instanceId !== this.#openedInstanceId) throw new Error("relayer journal identity changed");
  }
  backupTo(destination: string): Promise<void> { return this.#storage.backupTo(destination); }
  static restoreBackup(archive: string, newDirectory: string, key: Uint8Array, scope: RelayerScope): string {
    return EncryptedSqlite.restoreBackup(archive, newDirectory, key, journalNamespace(scope));
  }
  rotateKey(nextKey: Uint8Array): void {
    this.#storage.rotateKey(nextKey, [{ name: "operations", columns: ["id", "record"], primaryKey: ["id"],
      encrypted: { record: row => JSON.stringify([this.scope, String(row.id)]) } }], { "relayer-instance-v1": this.#instanceAad() });
  }
  /** Bounded, authenticated inventory. A cursor is an ID, not evidence of complete chain history. */
  page(afterId?: string, limit = 100): { records: RelayerRecord[]; nextCursor?: string } {
    if ((afterId !== undefined && !hex32(afterId)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid relayer inventory page");
    return this.#storage.transaction(() => {
      const rows = this.#storage.db.prepare("SELECT id FROM operations WHERE id>? ORDER BY id LIMIT ?").all(afterId ?? "", limit + 1);
      return { records: rows.slice(0, limit).map(row => this.get(String(row.id))!),
        ...(rows.length > limit ? { nextCursor: String(rows[limit - 1]!.id) } : {}) };
    });
  }
  #now(): number {
    const now = this.clock(); if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid relayer clock"); return now;
  }
  get(id: string): RelayerRecord | undefined {
    if (!hex32(id)) throw new Error("invalid relayer request ID");
    const row = this.#storage.db.prepare("SELECT record FROM operations WHERE id=?").get(id);
    if (!row) return;
    const bytes = this.#storage.open(row.record as Uint8Array, JSON.stringify([this.scope, id]));
    try {
      const value = JSON.parse(bytes.toString()) as RelayerRecord;
      if (value.id !== id || value.observation.requestIdHex !== id) throw new Error("relayer journal identity mismatch");
      return value;
    } finally { bytes.fill(0); }
  }
  #write(value: RelayerRecord): void {
    const bytes = Buffer.from(JSON.stringify(value));
    try { this.#storage.db.prepare("INSERT INTO operations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
      .run(value.id, this.#storage.seal(bytes, JSON.stringify([this.scope, value.id]))); }
    finally { bytes.fill(0); }
  }
  spent(now = this.#now()): bigint {
    let total = 0n;
    for (const row of this.#storage.db.prepare("SELECT id FROM operations").all()) {
      const r = this.get(String(row.id))!;
      if (r.packet && r.chargedAt !== undefined && now - r.chargedAt < 86_400_000) total += BigInt(r.packet.feeLamports) + BigInt(r.packet.rentLamports);
    }
    return total;
  }
  /** Bounded by maximumRecords. Called by periodic probes and atomic preparation, never by a public health poll. */
  inspect(balanceSlot: number, now = this.#now()) {
    let spent = 0n, unsettled = 0n;
    const ids = this.#storage.db.prepare("SELECT id FROM operations ORDER BY id").all();
    const reconcileIds: string[] = [];
    for (const row of ids) {
      const record = this.get(String(row.id))!; if (!record.packet) continue;
      const cost = BigInt(record.packet.feeLamports) + BigInt(record.packet.rentLamports);
      if (record.chargedAt !== undefined && now - record.chargedAt < 86_400_000) spent += cost;
      if (record.observation.confirmationStatus !== "finalized" || (record.observation.slot ?? Infinity) > balanceSlot) unsettled += cost;
      if (record.observation.confirmationStatus !== "finalized") reconcileIds.push(record.id);
    }
    return { records: ids.length, maximumRecords: this.maximumRecords, spent, unsettled, reconcileIds };
  }
  claim(id: string, digest: string): { record: RelayerRecord; token?: string } {
    if (!hex32(id) || !hex32(digest)) throw new Error("invalid relayer request identity");
    return this.#storage.transaction(() => {
      this.assertSubmissionAllowed();
      const prior = this.get(id), now = this.#now();
      if (prior && prior.digest !== digest) throw new HttpError(409, "request ID is bound to different content");
      if (prior?.packet || (prior?.lease && prior.lease.until > now)) return { record: prior };
      if (!prior && Number(this.#storage.db.prepare("SELECT COUNT(*) AS count FROM operations").get()!.count) >= this.maximumRecords) throw new HttpError(503, "relayer journal capacity exhausted");
      const token = randomBytes(32).toString("hex");
      const record: RelayerRecord = { id, digest, lease: { token, until: now + 30_000 }, observation: { requestIdHex: id, state: "preparing" }, observedSlot: 0 };
      this.#write(record); return { record, token };
    });
  }
  release(id: string, token: string): void {
    this.#storage.transaction(() => {
      this.assertSubmissionAllowed();
      const record = this.get(id);
      if (record?.lease?.token === token && !record.packet) this.#storage.db.prepare("DELETE FROM operations WHERE id=?").run(id);
    });
  }
  prepare(id: string, token: string, packet: RelayerPacket, funding: FundingEvidence): RelayerRecord {
    return this.#storage.transaction(() => {
      this.assertSubmissionAllowed();
      const record = this.get(id), now = this.#now();
      if (!record || record.packet || record.lease?.token !== token || record.lease.until <= now) throw new Error("relayer preparation lease lost");
      for (const value of [packet.feeLamports, packet.rentLamports]) if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("invalid relayer cost");
      const cost = BigInt(packet.feeLamports) + BigInt(packet.rentLamports);
      if (!funding || !Number.isSafeInteger(funding.slot) || funding.slot < packet.minContextSlot || funding.balanceLamports < 0n ||
        funding.minimumReserveLamports < 0n) throw new Error("invalid relayer funding evidence");
      const budget = this.inspect(funding.slot, now);
      if (cost > this.dailyBudget - budget.spent) throw new HttpError(503, "relayer daily budget exhausted");
      if (cost + budget.unsettled + funding.minimumReserveLamports > funding.balanceLamports) throw new HttpError(503, "relayer funding reserve unavailable");
      record.packet = structuredClone(packet); record.chargedAt = now; delete record.lease;
      record.observedSlot = packet.minContextSlot;
      record.observation = { requestIdHex: id, state: "pending", signature: packet.signature, tokenPairs: packet.tokenPairs };
      this.#write(record); return record; // FULL commit reserves the charge AND packet before send.
    });
  }
  observe(id: string, receipt: RelayerReceipt, slot: number): RelayerReceipt {
    return this.#storage.transaction(() => {
      const r = this.get(id);
      if (!r?.packet || receipt.requestIdHex !== id || receipt.signature !== r.packet.signature) throw new Error("relayer receipt identity mismatch");
      if (!Number.isSafeInteger(slot) || slot < r.observedSlot) throw new Error("stale relayer observation");
      if (r.observation.confirmationStatus !== "finalized") {
        // A disappeared/stale receipt cannot automatically enable a confirmed transaction to be sent again.
        if (r.observation.confirmationStatus !== "confirmed" || receipt.confirmationStatus) r.observation = { ...receipt, tokenPairs: r.packet.tokenPairs };
        r.observedSlot = slot; this.#write(r);
      }
      return r.observation;
    });
  }
}
