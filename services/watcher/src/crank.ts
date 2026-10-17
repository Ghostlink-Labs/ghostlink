import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { policyHash } from "@ghostlink/common";
import { executeChangeIx, pocketPda, POCKET, readPocketAccount } from "@ghostlink/service-kit";
import bs58 from "bs58";
import { CrankJournal, type CrankAttempt } from "./journal.js";

function context(slot: number, floor = 0): number {
  if (!Number.isSafeInteger(slot) || slot < floor) throw new Error("stale crank context");
  return slot;
}
function proposalId(account: ReturnType<typeof readPocketAccount>): string | undefined {
  const pending = account.pending;
  if (!pending) return;
  const change = "home" in pending.change ? ["home", pending.change.home.toBase58()] :
    ["policy", Buffer.from(policyHash(pending.change.policy)).toString("hex")];
  return createHash("sha256").update(JSON.stringify([pending.executableAfterSlot.toString(), change])).digest("hex");
}

/** Only the recorded signed packet may be retried until finalized expiry is proved. */
export class DurableCranker {
  #busy = new Set<string>();
  constructor(private readonly chain: Connection, private readonly payer: Keypair, readonly journal: CrankJournal) {
    if (journal.scope.payer !== payer.publicKey.toBase58() || journal.scope.pocketProgram !== POCKET.toBase58()) throw new Error("crank identity mismatch");
    if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(journal.scope.genesisHash)) {
      throw new Error("V2 watcher has no verified public deployment");
    }
  }
  async #account(pocket: string, minimum: number, commitment: "confirmed" | "finalized" = "confirmed") {
    const response = await this.chain.getAccountInfoAndContext(new PublicKey(pocket), { commitment, minContextSlot: minimum });
    context(response.context.slot, minimum);
    if (!response.value) throw new Error("crank pocket unavailable");
    const account = readPocketAccount(response.value);
    if (pocketPda(account.appId).toBase58() !== pocket) throw new Error("invalid crank pocket PDA");
    return { account, slot: response.context.slot, proposal: proposalId(account) };
  }
  #validate(record: CrankAttempt): void {
    const p = record.packet, bytes = Buffer.from(p.rawBase64, "base64");
    if (bytes.length > 1232 || bytes.toString("base64") !== p.rawBase64) throw new Error("invalid crank packet");
    const tx = Transaction.from(bytes);
    // Compile the expected message: a fee payer is globally writable even when the instruction marks it read-only.
    const expected = new Transaction({ feePayer: this.payer.publicKey, recentBlockhash: p.blockhash })
      .add(executeChangeIx(this.payer.publicKey, new PublicKey(record.pocket)));
    if (!tx.verifySignatures() || tx.signatures.length !== 1 || !tx.feePayer?.equals(this.payer.publicKey) ||
      tx.recentBlockhash !== p.blockhash || bs58.encode(tx.signature!) !== p.signature || !tx.serializeMessage().equals(expected.serializeMessage())) {
      throw new Error("crank packet identity mismatch");
    }
    context(p.lastValidBlockHeight); context(p.minContextSlot);
  }
  async #reconcile(record: CrankAttempt): Promise<CrankAttempt> {
    if (["finalized", "failed", "expired"].includes(record.state)) return record;
    const p = record.packet;
    const response = await this.chain.getSignatureStatuses([p.signature], { searchTransactionHistory: true });
    const slot = context(response.context.slot, record.observedSlot);
    if (response.value.length !== 1) throw new Error("invalid crank signature response");
    const status = response.value[0];
    if (status) {
      context(status.slot, p.minContextSlot);
      if (status.slot > slot) throw new Error("invalid crank signature context");
      const state = status.confirmationStatus === "finalized" ? (status.err === null ? "finalized" : "failed") :
        status.confirmationStatus === "confirmed" ? "confirmed" : "pending";
      return this.journal.observe(record.pocket, p.signature, state, slot);
    }
    const height = context(await this.chain.getBlockHeight({ commitment: "finalized", minContextSlot: slot }));
    if (height <= p.lastValidBlockHeight) return this.journal.observe(record.pocket, p.signature, "pending", slot);
    const valid = await this.chain.isBlockhashValid(p.blockhash, { commitment: "finalized", minContextSlot: slot });
    context(valid.context.slot, slot);
    if (valid.value !== false) throw new Error("conflicting crank expiry evidence");
    const current = await this.#account(record.pocket, valid.context.slot, "finalized");
    // A changed/missing proposal without signature history is ambiguous. Never invent a successful receipt.
    if (current.proposal !== record.proposal) throw new Error("crank outcome unavailable");
    return this.journal.observe(record.pocket, p.signature, "expired", current.slot);
  }
  async execute(pocket: string): Promise<void> {
    if (this.#busy.has(pocket)) return;
    this.#busy.add(pocket);
    try {
      if (await this.chain.getGenesisHash() !== this.journal.scope.genesisHash) throw new Error("crank genesis mismatch");
      this.journal.checkWritable();
      let record = this.journal.get(pocket);
      if (record) { this.#validate(record); record = await this.#reconcile(record); }
      const minimum = context(await this.chain.getSlot("confirmed"), record?.observedSlot ?? 0);
      const current = await this.#account(pocket, minimum);
      if (!current.proposal || current.account.pending!.executableAfterSlot > BigInt(current.slot)) return;
      if (record && record.proposal !== current.proposal && !["finalized", "failed", "expired"].includes(record.state)) return;
      if (!record || record.proposal !== current.proposal || record.state === "expired") {
        const latest = await this.chain.getLatestBlockhashAndContext({ commitment: "confirmed", minContextSlot: current.slot });
        context(latest.context.slot, current.slot); context(latest.value.lastValidBlockHeight);
        const tx = new Transaction({ feePayer: this.payer.publicKey, ...latest.value })
          .add(executeChangeIx(this.payer.publicKey, new PublicKey(pocket)));
        tx.sign(this.payer);
        const fee = await this.chain.getFeeForMessage(tx.compileMessage(), "confirmed");
        context(fee.context.slot, latest.context.slot);
        if (fee.value === null) throw new Error("crank fee unavailable");
        record = this.journal.prepare(pocket, current.proposal, { rawBase64: tx.serialize().toString("base64"),
          signature: bs58.encode(tx.signature!), blockhash: latest.value.blockhash,
          lastValidBlockHeight: latest.value.lastValidBlockHeight, minContextSlot: latest.context.slot }, fee.value);
      }
      if (record.state !== "pending" || record.proposal !== current.proposal) return;
      this.#validate(record);
      // Recheck both chain state and the durable row after asynchronous preparation; another worker may have progressed.
      const fresh = await this.#account(pocket, Math.max(current.slot, record.observedSlot, record.packet.minContextSlot));
      const saved = this.journal.get(pocket);
      if (fresh.proposal !== record.proposal || saved?.packet.signature !== record.packet.signature || saved.state !== "pending") return;
      this.journal.observe(pocket, record.packet.signature, "pending", Math.max(fresh.slot, saved.observedSlot));
      const p = record.packet;
      const ack = await this.chain.sendRawTransaction(Buffer.from(p.rawBase64, "base64"), {
        maxRetries: 0, skipPreflight: false, preflightCommitment: "confirmed", minContextSlot: fresh.slot,
      });
      if (ack !== p.signature) throw new Error("crank acknowledgment mismatch");
      const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 8000);
      try { await this.chain.confirmTransaction({ signature: p.signature, blockhash: p.blockhash,
        lastValidBlockHeight: p.lastValidBlockHeight, abortSignal: abort.signal }, "confirmed"); }
      finally { clearTimeout(timeout); abort.abort(); }
      await this.#reconcile(this.journal.get(pocket)!);
    } finally { this.#busy.delete(pocket); }
  }
}
