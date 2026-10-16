import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, policyHash, type IntentSubmission } from "@ghostlink/common";
import { POCKET, isPocketNonceUsed, pocketPda, readPocketAccount } from "@ghostlink/service-kit";
import bs58 from "bs58";
import { SubmissionJournal, type Attempt, type IntentIdentity, type PreparedTransaction } from "./journal.js";
import type { ValidatedIntent } from "./validate.js";

export type SubmissionChain = Pick<Connection, "getGenesisHash" | "getSlot" | "getAccountInfoAndContext" |
  "getSignatureStatuses" | "getBlockHeight" | "isBlockhashValid" | "sendRawTransaction" | "confirmTransaction">;

export class IntentAuthorizationError extends Error {
  constructor(message = "intent is not authorized by the current pocket") { super(message); this.name = "IntentAuthorizationError"; }
}

export function identityFor(v: ValidatedIntent): IntentIdentity {
  return { intentHashHex: bytesToHex(v.hash), pocket: bs58.encode(v.intent.pocket), nonce: v.intent.nonce.toString(),
    sessionKind: v.sessionKind, sessionKeyHex: bytesToHex(v.sessionKey) };
}

/** Persist first, broadcast identical bytes on retry, reconcile the exact signature. */
export class SubmissionCoordinator {
  #chain: SubmissionChain;
  #journal: SubmissionJournal;
  #timeout: number;
  constructor(chain: SubmissionChain, journal: SubmissionJournal, timeoutMs = 8_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000) throw new Error("invalid RPC timeout");
    if (journal.scope.pocketProgram !== POCKET.toBase58()) throw new Error("solver encoders do not match journal program");
    if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(journal.scope.genesisHash)) {
      throw new Error("V2 solver has no verified public deployment");
    }
    this.#chain = chain; this.#journal = journal; this.#timeout = timeoutMs;
  }

  async #rpc<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("RPC timeout")), this.#timeout); })]); }
    finally { clearTimeout(timer!); }
  }
  async #genesis(): Promise<void> {
    if (await this.#rpc(this.#chain.getGenesisHash()) !== this.#journal.scope.genesisHash) throw new Error("RPC genesis does not match journal");
  }
  #context(value: number, minimum: number): void {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error("RPC context is stale");
  }

  /** On-chain authority is checked before creating any durable nonce claim or preparing fees. */
  async authorize(v: ValidatedIntent, minimumSlot = 0): Promise<number> {
    const id = bytesToHex(v.hash), prior = this.#journal.get(id);
    await this.#genesis();
    const head = await this.#rpc(this.#chain.getSlot("confirmed")); this.#context(head, 0);
    const pocket = new PublicKey(v.intent.pocket);
    const slot = Math.max(head, minimumSlot, prior?.authorizationSlot ?? 0, prior?.transaction?.minContextSlot ?? 0,
      this.#journal.authorizationSlot(pocket.toBase58()));
    const response = await this.#rpc(this.#chain.getAccountInfoAndContext(new PublicKey(v.intent.pocket), { commitment: "confirmed", minContextSlot: slot }));
    this.#context(response.context.slot, slot);
    this.#journal.authorizedContext(id, response.context.slot);
    if (!response.value) throw new IntentAuthorizationError("pocket not found");
    const a = readPocketAccount(response.value);
    if (!pocketPda(a.appId).equals(pocket)) throw new IntentAuthorizationError();
    this.#journal.observePocketContext(pocket.toBase58(), response.context.slot);
    const key = new Uint8Array(33); key.set(v.sessionKey);
    if (a.sessionKind !== v.sessionKind ||
      !Buffer.from(a.sessionKey).equals(Buffer.from(key)) || !Buffer.from(policyHash(a.policy)).equals(Buffer.from(v.intent.policyHash)) ||
      a.sessionExpirySlot <= BigInt(response.context.slot) || v.intent.deadlineSlot < BigInt(response.context.slot) ||
      isPocketNonceUsed(a, v.intent.nonce)) throw new IntentAuthorizationError();
    return response.context.slot;
  }

  #validatePrepared(p: PreparedTransaction, minSlot: number): void {
    this.#context(p.minContextSlot, minSlot);
    if (!Number.isSafeInteger(p.lastValidBlockHeight) || p.lastValidBlockHeight < 0) throw new Error("invalid blockhash lifetime");
    const raw = Buffer.from(p.rawBase64, "base64");
    if (raw.toString("base64") !== p.rawBase64 || raw.length > 1232) throw new Error("invalid transaction bytes");
    const tx = VersionedTransaction.deserialize(raw);
    const payer = tx.message.staticAccountKeys[0];
    if (tx.signatures.length !== 1 || !payer || payer.toBase58() !== this.#journal.scope.solver ||
      tx.message.recentBlockhash !== p.blockhash || bs58.encode(tx.signatures[0]!) !== p.signature ||
      !ed25519.verify(tx.signatures[0]!, tx.message.serialize(), payer.toBytes())) throw new Error("transaction identity does not match journal");
  }

  async submit(v: ValidatedIntent, prepare: (minimumSlot: number) => Promise<PreparedTransaction>): Promise<IntentSubmission> {
    const identity = identityFor(v);
    await this.#genesis();
    let record = this.#journal.matching(identity);
    if (!record?.transaction) {
      const slot = await this.authorize(v);
      const claim = this.#journal.claim(identity); record = claim.record;
      if (claim.token) {
        try {
          this.#journal.authorizedContext(identity.intentHashHex, slot);
          const prepared = await this.#rpc(prepare(slot));
          this.#validatePrepared(prepared, slot);
          record = this.#journal.prepared(identity.intentHashHex, claim.token, prepared);
        } catch (error) { this.#journal.releasePreparation(identity.intentHashHex, claim.token); throw error; }
      }
    }
    if (!record.transaction) return record.observation;
    const observation = await this.status(identity.intentHashHex);
    // Only a fresh authoritative pending observation permits rebroadcast. No new transaction is constructed.
    if (observation.state !== "pending") return observation;
    try {
      const authorizationSlot = await this.authorize(v, record.transaction.minContextSlot);
      this.#journal.authorizedContext(identity.intentHashHex, authorizationSlot); // Fence a newer concurrent account observation.
      const tx = record.transaction;
      const returned = await this.#rpc(this.#chain.sendRawTransaction(Buffer.from(tx.rawBase64, "base64"), {
        skipPreflight: false, preflightCommitment: "confirmed", minContextSlot: authorizationSlot, maxRetries: 0,
      }));
      if (returned !== tx.signature) return { ...observation, state: "unknown", reason: "rpc_signature_mismatch" };
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.#timeout);
      try { await this.#rpc(this.#chain.confirmTransaction({ signature: tx.signature, blockhash: tx.blockhash,
        lastValidBlockHeight: tx.lastValidBlockHeight, abortSignal: abort.signal }, "confirmed")); }
      finally { clearTimeout(timer); abort.abort(); }
    } catch {
      // An exception cannot prove the transaction was not sent. The signature/bytes already exist durably.
    }
    return this.status(identity.intentHashHex);
  }

  async status(id: string): Promise<IntentSubmission> {
    const record = this.#journal.get(id);
    if (!record) throw new Error("intent not found");
    const tx = record.transaction;
    const base = { intentHashHex: id, ...(tx ? { signature: tx.signature } : {}) };
    try {
      await this.#genesis();
      if (!tx || record.observation.confirmationStatus === "finalized" || record.observation.state === "expired") return record.observation;
      const response = await this.#rpc(this.#chain.getSignatureStatuses([tx.signature], { searchTransactionHistory: true }));
      this.#context(response.context.slot, record.observedContext);
      if (response.value.length !== 1) throw new Error("invalid signature status result");
      const status = response.value[0];
      let observed: IntentSubmission;
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        this.#context(status.slot, tx.minContextSlot);
        if (status.slot > response.context.slot) throw new Error("inconsistent signature context");
        observed = { ...base, state: status.err === null ? status.confirmationStatus : "failed", slot: status.slot,
          confirmationStatus: status.confirmationStatus, ...(status.err === null ? {} : { chainError: status.err }) };
      } else if (status) observed = { ...base, state: "pending", reason: "processed_only" };
      else observed = await this.#absent(record);
      return this.#journal.observe(id, observed, response.context.slot).observation;
    } catch { return { ...base, state: "unknown", reason: "rpc_or_journal_evidence_unavailable" }; }
  }

  async #absent(record: Attempt): Promise<IntentSubmission> {
    const tx = record.transaction!;
    const base = { intentHashHex: record.identity.intentHashHex, signature: tx.signature };
    const height = await this.#rpc(this.#chain.getBlockHeight({ commitment: "confirmed", minContextSlot: tx.minContextSlot }));
    if (!Number.isSafeInteger(height) || height < 0) throw new Error("invalid block height");
    if (height <= tx.lastValidBlockHeight) return { ...base, state: "pending" };
    const finalizedHeight = await this.#rpc(this.#chain.getBlockHeight({ commitment: "finalized", minContextSlot: tx.minContextSlot }));
    if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight < 0) throw new Error("invalid finalized block height");
    if (finalizedHeight <= tx.lastValidBlockHeight) return { ...base, state: "unknown", reason: "awaiting_finalized_expiry" };
    const valid = await this.#rpc(this.#chain.isBlockhashValid(tx.blockhash, { commitment: "finalized", minContextSlot: tx.minContextSlot }));
    this.#context(valid.context.slot, tx.minContextSlot);
    if (valid.value) return { ...base, state: "unknown", reason: "conflicting_expiry_evidence" };
    const account = await this.#rpc(this.#chain.getAccountInfoAndContext(new PublicKey(record.identity.pocket), {
      commitment: "finalized", minContextSlot: valid.context.slot,
    }));
    this.#context(account.context.slot, valid.context.slot);
    if (!account.value) throw new Error("missing finalized pocket");
    const decoded = readPocketAccount(account.value);
    if (!pocketPda(decoded.appId).equals(new PublicKey(record.identity.pocket))) throw new Error("finalized pocket identity mismatch");
    return isPocketNonceUsed(decoded, BigInt(record.identity.nonce))
      ? { ...base, state: "unknown", reason: "nonce_consumed_without_signature_history" }
      : { ...base, state: "expired", reason: "blockhash_expired_and_finalized_nonce_unused" };
  }
}
