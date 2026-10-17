import { type Connection, Transaction } from "@solana/web3.js";
import type { RelayerJournal } from "./journal.js";
import { validateRelayerPacket } from "./submission.js";

export interface RelayerHistoryEntry {
  requestIdHex: string;
  signature?: string;
  outcome: "verified-finalized" | "unresolved" | "conflict" | "unprepared";
  reason?: string;
  slot?: number;
}

/**
 * Reconcile at most 100 retained packets, with four concurrent history reads.
 * No payer key, transaction building or broadcast. Never treats a missing RPC
 * record as nonexecution or evidence that a restored snapshot is complete.
 */
export async function reconcileRetainedRelayerOperations(
  chain: Connection, journal: RelayerJournal, afterId?: string,
) {
  if (await chain.getGenesisHash() !== journal.scope.genesisHash) throw new Error("relayer reconciliation chain mismatch");
  const page = journal.page(afterId);
  const floor = Math.max(0, ...page.records.map(r => r.observedSlot));
  const finalizedSlot = await chain.getSlot({ commitment: "finalized", minContextSlot: floor });
  if (!Number.isSafeInteger(finalizedSlot) || finalizedSlot < floor) throw new Error("stale relayer reconciliation context");
  const entries: RelayerHistoryEntry[] = new Array(page.records.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, page.records.length) }, async () => {
    while (cursor < page.records.length) {
      const index = cursor++, record = page.records[index]!;
      const base = { requestIdHex: record.id, signature: record.packet?.signature };
      if (!record.packet) { entries[index] = { ...base, outcome: "unprepared" }; continue; }
      const packet = record.packet;
      try { validateRelayerPacket(packet, journal.scope.payer); }
      catch { entries[index] = { ...base, outcome: "conflict", reason: "saved_packet_invalid" }; continue; }
      try {
        const found = await chain.getTransaction(packet.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        if (!found) { entries[index] = { ...base, outcome: "unresolved", reason: "finalized_history_unavailable" }; continue; }
        const message = found.transaction.message;
        if (message.version !== "legacy" || !Number.isSafeInteger(found.slot) || found.slot < packet.minContextSlot || found.slot > finalizedSlot ||
          !found.meta || !Number.isSafeInteger(found.meta.fee) || found.meta.fee < 0 || BigInt(found.meta.fee) > BigInt(packet.feeLamports) ||
          Transaction.populate(message, found.transaction.signatures).serialize().toString("base64") !== packet.rawBase64) {
          entries[index] = { ...base, outcome: "conflict", reason: "finalized_transaction_mismatch" }; continue;
        }
        const state = found.meta.err === null ? "finalized" : "failed";
        if (record.observation.confirmationStatus === "finalized" &&
          (record.observation.slot !== found.slot || record.observation.state !== state)) {
          entries[index] = { ...base, outcome: "conflict", reason: "saved_finality_mismatch" }; continue;
        }
        journal.observe(record.id, { ...base, state, slot: found.slot, confirmationStatus: "finalized" }, finalizedSlot);
        entries[index] = { ...base, outcome: "verified-finalized", slot: found.slot };
      } catch { entries[index] = { ...base, outcome: "unresolved", reason: "history_or_storage_unavailable" }; }
    }
  }));
  return { scope: journal.scope, recoveryId: journal.recoveryId, finalizedSlot, entries, nextCursor: page.nextCursor,
    historyCompleteness: "not-established" as const, paidResumptionAllowed: false as const };
}
