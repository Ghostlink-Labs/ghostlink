import { describe, expect, it, vi } from "vitest";
import { AddressLookupTableProgram, ComputeBudgetProgram, Keypair, SystemProgram,
  TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { prepareVersionedTransaction, DEFAULT_TRANSACTION_LIMITS, type TransactionChain } from "../src/transactions.js";

function world() {
  const payer = Keypair.generate(), destination = Keypair.generate().publicKey, table = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const data = Buffer.alloc(88); data.writeUInt32LE(1); data.writeBigUInt64LE(0xffffffffffffffffn, 4);
  data.writeBigUInt64LE(90n, 12); destination.toBuffer().copy(data, 56);
  const account = { data, owner: AddressLookupTableProgram.programId, executable: false, lamports: 1, rentEpoch: 0 };
  const chain = {
    getAccountInfoAndContext: vi.fn(async () => ({ context: { slot: 100 }, value: account })),
    getLatestBlockhashAndContext: vi.fn(async () => ({ context: { slot: 100 }, value: { blockhash, lastValidBlockHeight: 200 } })),
    simulateTransaction: vi.fn(async () => ({ context: { slot: 100 }, value: { err: null, unitsConsumed: 500 } })),
    getFeeForMessage: vi.fn(async () => ({ context: { slot: 100 }, value: 5_001 as number | null })),
    getBlockHeight: vi.fn(async () => 100),
  };
  const instruction = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: destination, lamports: 1 });
  const input = { instructions: [instruction], lookupTables: [{ address: table, addresses: [destination] }],
    minimumSlot: 100, deadlineSlot: 500n, limits: { ...DEFAULT_TRANSACTION_LIMITS, priorityMicroLamports: 1000n } };
  const run = () => prepareVersionedTransaction(chain as unknown as TransactionChain, payer, input);
  return { payer, destination, table, blockhash, data, account, chain, input, run };
}

describe("versioned transaction preparation", () => {
  it("resolves real table bytes, simulates the complete message twice and signs only after the exact final fee passes", async () => {
    const w = world(), packet = await w.run();
    const tx = VersionedTransaction.deserialize(Buffer.from(packet.rawBase64, "base64"));
    expect(tx.version).toBe(0); expect(tx.message.addressTableLookups).toHaveLength(1);
    expect(tx.message.addressTableLookups[0]?.accountKey.equals(w.table)).toBe(true);
    expect(bs58.encode(tx.signatures[0]!)).toBe(packet.signature);
    expect(ed25519.verify(tx.signatures[0]!, tx.message.serialize(), w.payer.publicKey.toBytes())).toBe(true);
    expect(w.chain.simulateTransaction).toHaveBeenCalledTimes(2);
    const calls = w.chain.simulateTransaction.mock.calls as unknown as [VersionedTransaction, object][];
    expect(calls[0]![0].signatures[0]!.every(b => b === 0)).toBe(true);
    // The second simulation object may subsequently be signed, but its compiled message must remain unchanged.
    expect(Buffer.from(calls[1]![0].message.serialize())).toEqual(Buffer.from(tx.message.serialize()));
    const feeCall = w.chain.getFeeForMessage.mock.calls[0] as unknown as [typeof tx.message, string];
    expect(Buffer.from(feeCall[0].serialize())).toEqual(Buffer.from(tx.message.serialize())); expect(feeCall[1]).toBe("confirmed");
    expect(calls[1]![1]).toMatchObject({ minContextSlot: 100, sigVerify: false, replaceRecentBlockhash: false });
    expect(Buffer.from(tx.message.compiledInstructions[0]!.data)).toEqual(ComputeBudgetProgram.setComputeUnitLimit({ units: 600 }).data);
  });

  it("refuses forged mappings, wrong owners, deactivated/warm tables and stale bank responses", async () => {
    for (const corrupt of [
      (w: ReturnType<typeof world>) => { w.input.lookupTables[0]!.addresses[0] = Keypair.generate().publicKey; },
      (w: ReturnType<typeof world>) => { w.account.owner = SystemProgram.programId; },
      (w: ReturnType<typeof world>) => { w.data.writeBigUInt64LE(99n, 4); },
      (w: ReturnType<typeof world>) => { w.data.writeBigUInt64LE(100n, 12); },
      (w: ReturnType<typeof world>) => { w.chain.getAccountInfoAndContext.mockResolvedValue({ context: { slot: -1 }, value: w.account }); },
    ]) {
      const w = world(); corrupt(w); await expect(w.run()).rejects.toThrow();
      expect(w.chain.simulateTransaction).not.toHaveBeenCalled();
    }
  });

  it("requires rooted lookup mappings without lowering the newer confirmed authority floor", async () => {
    const w = world();
    w.chain.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 95 }, value: w.account });
    await w.run();
    expect(w.chain.getAccountInfoAndContext).toHaveBeenCalledWith(w.table, { commitment: "finalized", minContextSlot: 0 });
    expect(w.chain.getLatestBlockhashAndContext).toHaveBeenCalledWith({ commitment: "confirmed", minContextSlot: 100 });
    w.data.writeBigUInt64LE(95n, 12);
    await expect(w.run()).rejects.toThrow(/warming up/);
    w.chain.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 95 }, value: null as never });
    await expect(w.run()).rejects.toThrow(/lookup-table account/);
  });

  it("rejects failed or incomplete simulation, unsafe compute, network fees and expiring blockhashes", async () => {
    const failed = world(); failed.chain.simulateTransaction.mockResolvedValue({ context: { slot: 100 }, value: { err: "bad" as never, unitsConsumed: 500 } });
    await expect(failed.run()).rejects.toThrow(/failed simulation/); expect(failed.chain.getFeeForMessage).not.toHaveBeenCalled();
    const missing = world(); missing.chain.simulateTransaction.mockResolvedValue({ context: { slot: 100 }, value: { err: null, unitsConsumed: undefined as never } });
    await expect(missing.run()).rejects.toThrow(/compute estimate/);
    const over = world(); over.input.limits.maxComputeUnits = 550;
    await expect(over.run()).rejects.toThrow(/compute budget/);
    const expensive = world(); expensive.chain.getFeeForMessage.mockResolvedValue({ context: { slot: 100 }, value: 20_001 });
    await expect(expensive.run()).rejects.toThrow(/network fee/);
    const unknown = world(); unknown.chain.getFeeForMessage.mockResolvedValue({ context: { slot: 100 }, value: null });
    await expect(unknown.run()).rejects.toThrow(/network fee/);
    const expiry = world(); expiry.chain.getBlockHeight.mockResolvedValue(198);
    await expect(expiry.run()).rejects.toThrow(/expiry/);
    const fee = world(); fee.input.limits.priorityMicroLamports = 1_000_000_000n;
    await expect(fee.run()).rejects.toThrow(/priority fee/); expect(fee.chain.simulateTransaction).not.toHaveBeenCalled();
  });

  it("refuses a failing final message, changed blockhash, stale final evidence and passed intent deadline", async () => {
    const final = world(); final.chain.simulateTransaction.mockResolvedValueOnce({ context: { slot: 100 }, value: { err: null, unitsConsumed: 500 } })
      .mockResolvedValueOnce({ context: { slot: 100 }, value: { err: "final failed" as never, unitsConsumed: 500 } });
    await expect(final.run()).rejects.toThrow(/failed simulation/); expect(final.chain.getFeeForMessage).not.toHaveBeenCalled();
    const changed = world(); changed.chain.simulateTransaction.mockResolvedValue({ context: { slot: 100 },
      value: { err: null, unitsConsumed: 500, replacementBlockhash: { blockhash: changed.blockhash } } } as never);
    await expect(changed.run()).rejects.toThrow(/substituted/);
    const stale = world(); stale.chain.getFeeForMessage.mockResolvedValue({ context: { slot: 99 }, value: 5_000 });
    await expect(stale.run()).rejects.toThrow(/stale/);
    const late = world(); late.chain.simulateTransaction.mockResolvedValue({ context: { slot: 501 }, value: { err: null, unitsConsumed: 500 } });
    await expect(late.run()).rejects.toThrow(/expired/);
  });

  it("snapshots the plan before awaits and refuses additional signers, budget overrides and oversized packets", async () => {
    const w = world(), expected = Buffer.from(w.input.instructions[0]!.data);
    const pending = w.run(); w.input.instructions[0]!.data.fill(0); w.input.limits.priorityMicroLamports = 999_999_999n;
    w.input.lookupTables[0]!.addresses[0] = Keypair.generate().publicKey;
    const packet = await pending, tx = VersionedTransaction.deserialize(Buffer.from(packet.rawBase64, "base64"));
    expect(Buffer.from(tx.message.compiledInstructions[2]!.data)).toEqual(expected);
    const signer = world(); signer.input.instructions[0]!.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false });
    await expect(signer.run()).rejects.toThrow(/signer/);
    const override = world(); override.input.instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000n }));
    await expect(override.run()).rejects.toThrow(/override/);
    const large = world(); large.input.instructions.push(new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(1200) }));
    await expect(large.run()).rejects.toThrow(); expect(large.chain.simulateTransaction).not.toHaveBeenCalled();
  });
});
