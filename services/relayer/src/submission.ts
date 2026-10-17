import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { relayerRequestDigest, type RelayerRoute } from "@ghostlink/common";
import { POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import bs58 from "bs58";
import { RelayerJournal, type RelayerPacket, type RelayerReceipt, type RelayerRecord } from "./journal.js";

/** Bound to exact JSON content, independent of object-key ordering. Proof regeneration is a new request. */
export function requestIdentity(route: string, request: Record<string, unknown>) {
  const { requestIdHex } = request;
  const digest = relayerRequestDigest(route as RelayerRoute, request);
  if (route === "/snapshot" && requestIdHex === undefined) throw new Error("snapshot requires a requestIdHex reused only for retries");
  const id = requestIdHex ?? digest;
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) throw new Error("requestIdHex must be 32 bytes of lowercase hex");
  return { id, digest };
}
function context(slot: number, minimum = 0): number {
  if (!Number.isSafeInteger(slot) || slot < minimum) throw new Error("stale relayer context"); return slot;
}
export function validateRelayerPacket(packet: RelayerPacket, payer: string): Transaction {
  const bytes = Buffer.from(packet.rawBase64, "base64"), tx = Transaction.from(bytes);
  if (bytes.length > 1232 || bytes.toString("base64") !== packet.rawBase64 || !tx.verifySignatures() ||
    !tx.feePayer?.equals(new PublicKey(payer)) || tx.recentBlockhash !== packet.blockhash ||
    bs58.encode(tx.signature!) !== packet.signature) throw new Error("relayer packet identity mismatch");
  context(packet.minContextSlot); context(packet.lastValidBlockHeight);
  return tx;
}

export class RelayerSubmission {
  constructor(private readonly chain: Connection, readonly journal: RelayerJournal,
    private readonly minimumReserveLamports = 50_000_000n, private readonly preparationGuard: () => void = () => {}) {
    if (minimumReserveLamports < 0n) throw new Error("invalid relayer reserve");
    if (journal.scope.pocket !== POCKET.toBase58() || journal.scope.registry !== REGISTRY.toBase58() || journal.scope.census !== CENSUS.toBase58()) throw new Error("relayer journal program mismatch");
    if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(journal.scope.genesisHash)) throw new Error("V2 relayer has no verified public deployment");
  }
  #validate(packet: RelayerPacket): void {
    validateRelayerPacket(packet, this.journal.scope.payer);
  }
  async #genesis() {
    if (await this.chain.getGenesisHash() !== this.journal.scope.genesisHash) throw new Error("relayer chain mismatch");
  }
  async status(id: string): Promise<RelayerReceipt> {
    const record = this.journal.get(id); if (!record) throw new Error("relayer operation not found");
    const base = { requestIdHex: id, signature: record.packet?.signature, tokenPairs: record.packet?.tokenPairs };
    try {
      await this.#genesis();
      if (!record.packet || record.observation.confirmationStatus === "finalized") return record.observation;
      this.#validate(record.packet);
      const response = await this.chain.getSignatureStatuses([record.packet.signature], { searchTransactionHistory: true });
      const slot = context(response.context.slot, record.observedSlot);
      if (response.value.length !== 1) throw new Error("invalid relayer signature response");
      const status = response.value[0];
      if (status && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        context(status.slot, record.packet.minContextSlot);
        if (status.slot > slot) throw new Error("invalid relayer status context");
        return this.journal.observe(id, { ...base, state: status.err === null ? status.confirmationStatus as "confirmed" | "finalized" : "failed",
          slot: status.slot, confirmationStatus: status.confirmationStatus as "confirmed" | "finalized" }, slot);
      }
      const height = context(await this.chain.getBlockHeight({ commitment: "confirmed", minContextSlot: slot }));
      const receipt: RelayerReceipt = height > record.packet.lastValidBlockHeight
        ? { ...base, state: "unknown", reason: "blockhash_expired_outcome_unavailable" }
        : { ...base, state: "pending" };
      return this.journal.observe(id, receipt, slot);
    } catch { return { ...base, state: "unknown", reason: "rpc_or_journal_evidence_unavailable" }; }
  }
  async submit(id: string, digest: string, prepare: () => Promise<RelayerPacket>): Promise<RelayerReceipt> {
    this.journal.assertSubmissionAllowed();
    await this.#genesis(); this.journal.checkWritable();
    const claim = this.journal.claim(id, digest); let record: RelayerRecord = claim.record;
    if (claim.token) {
      try {
        this.preparationGuard(); const packet = await prepare(); this.#validate(packet);
        const balance = await this.chain.getBalanceAndContext(new PublicKey(this.journal.scope.payer), { commitment: "confirmed", minContextSlot: packet.minContextSlot });
        context(balance.context.slot, packet.minContextSlot);
        if (!Number.isSafeInteger(balance.value) || balance.value < 0) throw new Error("invalid relayer payer balance");
        this.preparationGuard();
        record = this.journal.prepare(id, claim.token, packet, { balanceLamports: BigInt(balance.value), slot: balance.context.slot, minimumReserveLamports: this.minimumReserveLamports });
      }
      catch (e) { this.journal.release(id, claim.token); throw e; }
    }
    if (!record.packet) return record.observation;
    const receipt = await this.status(id);
    if (receipt.state !== "pending") return receipt;
    const packet = record.packet;
    try {
      // The journal is immutable after preparation: repeated requests cannot select new blockhashes or sweep accounts.
      const ack = await this.chain.sendRawTransaction(Buffer.from(packet.rawBase64, "base64"), {
        maxRetries: 0, skipPreflight: false, preflightCommitment: "confirmed", minContextSlot: this.journal.get(id)!.observedSlot,
      });
      if (ack !== packet.signature) return { ...receipt, state: "unknown", reason: "rpc_signature_mismatch" };
      const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 8000);
      try { await this.chain.confirmTransaction({ signature: packet.signature, blockhash: packet.blockhash,
        lastValidBlockHeight: packet.lastValidBlockHeight, abortSignal: abort.signal }, "confirmed"); }
      finally { clearTimeout(timeout); abort.abort(); }
    } catch { /* Outcome stays tied to the durable packet even when the reply is lost. */ }
    return this.status(id);
  }
}
