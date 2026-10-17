import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, PublicKey,
  TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { PreparedTransaction } from "./journal.js";

export interface LookupTableRequest {
  address: PublicKey;
  /** Expected mapping supplied by the reviewed planner; independently checked against RPC. */
  addresses: readonly PublicKey[];
}
export interface TransactionLimits {
  maxComputeUnits: number;
  priorityMicroLamports: bigint;
  /** Network fee only; rent, token movement and protocol charges require separate plan validation. */
  maxNetworkFeeLamports: bigint;
}
export const DEFAULT_TRANSACTION_LIMITS: Readonly<TransactionLimits> = Object.freeze({
  maxComputeUnits: 1_400_000, priorityMicroLamports: 0n, maxNetworkFeeLamports: 20_000n,
});
export type TransactionChain = Pick<Connection, "getAccountInfoAndContext" | "getLatestBlockhashAndContext" |
  "simulateTransaction" | "getFeeForMessage" | "getBlockHeight">;

export class TransactionPreparationError extends Error {
  constructor(message: string) { super(message); this.name = "TransactionPreparationError"; }
}
function refuse(message: string): never { throw new TransactionPreparationError(message); }
function context(slot: number, minimum: number, deadline: bigint): number {
  if (!Number.isSafeInteger(slot) || slot < minimum) refuse("stale transaction preparation context");
  if (BigInt(slot) > deadline) refuse("intent expired during transaction preparation");
  return slot;
}
async function rpc<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TransactionPreparationError("preparation RPC timeout")), 5_000);
  })]); } finally { clearTimeout(timer!); }
}
function copyInstruction(ix: TransactionInstruction): TransactionInstruction {
  return new TransactionInstruction({ programId: new PublicKey(ix.programId.toBytes()), data: Buffer.from(ix.data),
    keys: ix.keys.map(k => ({ pubkey: new PublicKey(k.pubkey.toBytes()), isSigner: k.isSigner, isWritable: k.isWritable })) });
}

/** Compose a previously reviewed instruction plan; this is not an arbitrary route validator. */
export async function prepareVersionedTransaction(chain: TransactionChain, payer: Keypair,
  input: { instructions: readonly TransactionInstruction[]; lookupTables?: readonly LookupTableRequest[];
    minimumSlot: number; deadlineSlot: bigint; limits?: TransactionLimits }): Promise<PreparedTransaction> {
  const instructions = input.instructions.map(copyInstruction);
  const requested = (input.lookupTables ?? []).map(t => ({ address: new PublicKey(t.address.toBytes()),
    addresses: t.addresses.map(a => new PublicKey(a.toBytes())) }));
  const limits = { ...(input.limits ?? DEFAULT_TRANSACTION_LIMITS) }, deadline = input.deadlineSlot;
  let minimum = context(input.minimumSlot, 0, deadline);
  if (!Number.isInteger(limits.maxComputeUnits) || limits.maxComputeUnits < 1 || limits.maxComputeUnits > 1_400_000 ||
      typeof limits.priorityMicroLamports !== "bigint" || limits.priorityMicroLamports < 0n || limits.priorityMicroLamports > 0xffffffffffffffffn ||
      typeof limits.maxNetworkFeeLamports !== "bigint" || limits.maxNetworkFeeLamports <= 0n) refuse("invalid transaction fee/compute limits");
  const priorityAtLimit = (limits.priorityMicroLamports * BigInt(limits.maxComputeUnits) + 999_999n) / 1_000_000n;
  if (priorityAtLimit > limits.maxNetworkFeeLamports) refuse("priority fee exceeds transaction budget");
  if (instructions.length === 0 || instructions.length > 64 || requested.length > 8 ||
      new Set(requested.map(t => t.address.toBase58())).size !== requested.length) refuse("invalid instruction or lookup-table count");
  for (const ix of instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) refuse("planner cannot override transaction compute or fees");
    if (ix.keys.some(k => k.isSigner && !k.pubkey.equals(payer.publicKey))) refuse("plan requires an unapproved transaction signer");
  }

  const tables: AddressLookupTableAccount[] = [];
  let lookupContext = 0;
  for (const table of requested) {
    if (table.addresses.length === 0 || table.addresses.length > 256) refuse("invalid lookup-table mapping size");
    // Mapping integrity needs a rooted table. Its finalized bank may legitimately
    // precede the confirmed authority bank; never lower that authority floor.
    const response = await rpc(chain.getAccountInfoAndContext(table.address, { commitment: "finalized", minContextSlot: lookupContext }));
    lookupContext = context(response.context.slot, lookupContext, deadline);
    minimum = Math.max(minimum, lookupContext);
    const account = response.value;
    if (!account || account.executable || !account.owner.equals(AddressLookupTableProgram.programId) ||
        account.data.length < 56 || account.data.length > 56 + 256 * 32) refuse("invalid lookup-table account");
    const state = AddressLookupTableAccount.deserialize(account.data);
    if (state.deactivationSlot !== 0xffffffffffffffffn || !Number.isSafeInteger(state.lastExtendedSlot) ||
        state.lastExtendedSlot >= lookupContext || state.lastExtendedSlotStartIndex > state.addresses.length ||
        state.addresses.length !== table.addresses.length || state.addresses.some((a, i) => !a.equals(table.addresses[i]!))) {
      refuse("lookup table is inactive, warming up or does not match the route");
    }
    tables.push(new AddressLookupTableAccount({ key: table.address, state }));
  }

  const latest = await rpc(chain.getLatestBlockhashAndContext({ commitment: "confirmed", minContextSlot: minimum }));
  minimum = context(latest.context.slot, minimum, deadline);
  const { blockhash, lastValidBlockHeight } = latest.value;
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 0 || new PublicKey(blockhash).toBase58() !== blockhash) refuse("invalid blockhash lifetime");
  const build = (units: number) => {
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: limits.priorityMicroLamports }), ...instructions],
    }).compileToV0Message(tables);
    if (message.header.numRequiredSignatures !== 1 || message.getAccountKeys({ addressLookupTableAccounts: tables }).length > 64) {
      refuse("transaction exceeds the supported signer/account budget");
    }
    const tx = new VersionedTransaction(message);
    if (tx.serialize().length > 1232) refuse("transaction exceeds the supported packet size");
    return tx;
  };
  const simulate = async (tx: VersionedTransaction, units: number) => {
    const result = await rpc(chain.simulateTransaction(tx, { commitment: "confirmed", minContextSlot: minimum,
      sigVerify: false, replaceRecentBlockhash: false }));
    minimum = context(result.context.slot, minimum, deadline);
    if (result.value.err !== null) refuse("complete fill transaction failed simulation");
    const consumed = result.value.unitsConsumed;
    if (!Number.isSafeInteger(consumed) || consumed! <= 0 || consumed! > units ||
        ("replacementBlockhash" in result.value && result.value.replacementBlockhash)) {
      refuse("invalid compute estimate or substituted simulation blockhash");
    }
    return consumed!;
  };
  const estimate = await simulate(build(limits.maxComputeUnits), limits.maxComputeUnits);
  const computeUnits = Math.ceil(estimate * 1.2);
  if (computeUnits > limits.maxComputeUnits) refuse("simulation requires more than the approved compute budget");
  const transaction = build(computeUnits);
  // The final message has a different budget; validate that exact message before releasing a signature.
  await simulate(transaction, computeUnits);
  const fee = await rpc(chain.getFeeForMessage(transaction.message, "confirmed"));
  minimum = context(fee.context.slot, minimum, deadline);
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0 || BigInt(fee.value) > limits.maxNetworkFeeLamports) {
    refuse("network fee is unavailable or exceeds the approved budget");
  }
  const height = await rpc(chain.getBlockHeight({ commitment: "confirmed", minContextSlot: minimum }));
  if (!Number.isSafeInteger(height) || height < 0 || height + 5 > lastValidBlockHeight) refuse("blockhash is too close to expiry");
  transaction.sign([payer]);
  return { rawBase64: Buffer.from(transaction.serialize()).toString("base64"), signature: bs58.encode(transaction.signatures[0]!),
    blockhash, lastValidBlockHeight, minContextSlot: minimum };
}
