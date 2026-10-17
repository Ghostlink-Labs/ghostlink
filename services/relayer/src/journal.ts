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
const hex32 = (s: string) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

export class RelayerJournal {
  readonly scope: Readonly<RelayerScope>;
  readonly dailyBudget: bigint;
  #storage: EncryptedSqlite;
  constructor(path: string, key: Uint8Array, scope: RelayerScope, dailyBudget = 2_000_000_000n,
    private readonly clock = Date.now, private readonly maximumRecords = 10_000) {
    this.scope = Object.freeze({ genesisHash: scope.genesisHash, payer: scope.payer, pocket: scope.pocket, registry: scope.registry, census: scope.census }); this.dailyBudget = dailyBudget;
    for (const id of Object.values(scope)) if (new PublicKey(id).toBase58() !== id) throw new Error("invalid relayer scope");
    if (dailyBudget < 0n || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1) throw new Error("invalid relayer journal limits");
    const namespace = "ghostlink:relayer:v1:" + createHash("sha256").update(JSON.stringify(this.scope)).digest("hex");
    this.#storage = new EncryptedSqlite(path, key, namespace);
    try {
      if (this.#storage.recoveryId) throw new Error("restored relayer journal requires operator reconciliation");
      this.#storage.transaction(() => this.#storage.db.exec("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, record BLOB NOT NULL) STRICT"));
    } catch (e) { this.#storage.close(); throw e; }
  }
  close(): void { this.#storage.close(); }
  checkWritable(): void { this.#storage.checkWritable(); }
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
  claim(id: string, digest: string): { record: RelayerRecord; token?: string } {
    if (!hex32(id) || !hex32(digest)) throw new Error("invalid relayer request identity");
    return this.#storage.transaction(() => {
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
      const record = this.get(id);
      if (record?.lease?.token === token && !record.packet) this.#storage.db.prepare("DELETE FROM operations WHERE id=?").run(id);
    });
  }
  prepare(id: string, token: string, packet: RelayerPacket): RelayerRecord {
    return this.#storage.transaction(() => {
      const record = this.get(id), now = this.#now();
      if (!record || record.packet || record.lease?.token !== token || record.lease.until <= now) throw new Error("relayer preparation lease lost");
      for (const value of [packet.feeLamports, packet.rentLamports]) if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("invalid relayer cost");
      const cost = BigInt(packet.feeLamports) + BigInt(packet.rentLamports);
      if (cost > this.dailyBudget - this.spent(now)) throw new HttpError(503, "relayer daily budget exhausted");
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
