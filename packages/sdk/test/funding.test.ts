import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { pocketPda } from "@ghostlink/common";
import { prepareFundingTransaction, type FundingApproval } from "../src/funding.js";

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7));
const other = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
const mint = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
const pocket = new PublicKey(pocketPda(42n).address);
const token = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ataProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), token.toBuffer(), mint.toBuffer()], ataProgram)[0];
const approval = (spl = false): FundingApproval => ({ appId: 42n, funder: wallet.publicKey.toBytes(),
  asset: spl ? { kind: "spl", mint: mint.toBytes(), rawAmount: 9_007_199_254_740_993n } : { kind: "sol", lamports: 1_000_000n },
  recentBlockhash: new Uint8Array(32).fill(3),
});
function fixture(spl = false): Transaction {
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: other.toBase58() });
  if (!spl) return tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: pocket, lamports: 1_000_000n }));
  const key = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
  const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(9_007_199_254_740_993n, 1);
  return tx.add(new TransactionInstruction({ programId: ataProgram,
    keys: [key(wallet.publicKey, true, true), key(ata(pocket), false, true), key(pocket), key(mint), key(SystemProgram.programId), key(token)], data: Buffer.from([1]),
  }), new TransactionInstruction({ programId: token,
    keys: [key(ata(wallet.publicKey), false, true), key(ata(pocket), false, true), key(wallet.publicKey, true)], data,
  }));
}
const wire = (tx: Transaction) => tx.serialize({ requireAllSignatures: false, verifySignatures: false });

describe("wallet-side funding approval", () => {
  it.each([false, true])("accepts the exact deposit, copies bytes and refreshes the blockhash (SPL=%s)", spl => {
    const input = wire(fixture(spl)), original = Buffer.from(input), consent = approval(spl);
    const checked = prepareFundingTransaction(input, consent);
    const decoded = Transaction.from(checked);
    expect(decoded.recentBlockhash).toBe(new PublicKey(consent.recentBlockhash).toBase58());
    expect(decoded.feePayer!.equals(wallet.publicKey)).toBe(true);
    expect(decoded.signatures).toHaveLength(1);
    expect(decoded.signatures[0]!.signature).toBeNull();
    expect(input).toEqual(original);
    // Buffer inputs, consent keys and returned bytes must never alias.
    input.fill(0); consent.funder.fill(0); consent.recentBlockhash.fill(0);
    decoded.partialSign(wallet);
    expect(decoded.verifySignatures()).toBe(true);
    expect(Transaction.from(checked).recentBlockhash).toBe(new PublicKey(new Uint8Array(32).fill(3)).toBase58());
  });

  it("refuses substituted destination, amount, funder, mint and app ID", () => {
    const tx = fixture(); tx.instructions[0]!.keys[1]!.pubkey = other;
    expect(() => prepareFundingTransaction(wire(tx), approval())).toThrow();
    for (const consent of [
      { ...approval(), appId: 43n }, { ...approval(), funder: other.toBytes() },
      { ...approval(), asset: { kind: "sol" as const, lamports: 1_000_001n } },
    ]) expect(() => prepareFundingTransaction(wire(fixture()), consent)).toThrow();
    expect(() => prepareFundingTransaction(wire(fixture(true)), { ...approval(true), asset: { kind: "spl", mint: other.toBytes(), rawAmount: 9_007_199_254_740_993n } })).toThrow();
    const spl = fixture(true); spl.instructions[1]!.data.writeBigUInt64LE(9_007_199_254_740_992n, 1);
    expect(() => prepareFundingTransaction(wire(spl), approval(true))).toThrow();
  });

  it("refuses extra transfers, program substitution, signer and permission escalation", () => {
    const extra = fixture(); extra.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: other, lamports: 1n }));
    expect(() => prepareFundingTransaction(wire(extra), approval())).toThrow();
    const wrongProgram = fixture(true); wrongProgram.instructions[1]!.programId = other;
    expect(() => prepareFundingTransaction(wire(wrongProgram), approval(true))).toThrow();
    const extraSigner = fixture(); extraSigner.instructions[0]!.keys[1]!.isSigner = true;
    expect(() => prepareFundingTransaction(wire(extraSigner), approval())).toThrow();
    const extraWritable = fixture(true); extraWritable.instructions[0]!.keys[3]!.isWritable = true;
    expect(() => prepareFundingTransaction(wire(extraWritable), approval(true))).toThrow();
    const reversed = fixture(true); reversed.instructions.reverse();
    expect(() => prepareFundingTransaction(wire(reversed), approval(true))).toThrow();
  });

  it("refuses signed, versioned, truncated, oversized and noncanonical encodings", () => {
    const tx = fixture(); tx.partialSign(wallet);
    expect(() => prepareFundingTransaction(wire(tx), approval())).toThrow(/unsigned/);
    const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: other.toBase58(), instructions: fixture().instructions }).compileToV0Message());
    expect(() => prepareFundingTransaction(v0.serialize(), approval())).toThrow();
    const valid = wire(fixture());
    for (let end = 0; end < valid.length; end++) expect(() => prepareFundingTransaction(valid.subarray(0, end), approval())).toThrow();
    for (const bad of [new Uint8Array(1233), Uint8Array.of(...valid, 0), Uint8Array.of(0x81, 0, ...valid.subarray(1))]) {
      expect(() => prepareFundingTransaction(bad, approval())).toThrow();
    }
  });

  it.each([false, true])("rejects every single-byte alteration outside the replaceable blockhash (SPL=%s)", spl => {
    const valid = wire(fixture(spl));
    const blockhashOffset = 1 + 64 + 3 + 1 + (spl ? 8 : 3) * 32;
    const consent = approval(spl);
    for (let index = 0; index < valid.length; index++) {
      if (index >= blockhashOffset && index < blockhashOffset + 32) continue;
      const altered = Buffer.from(valid); altered[index] = altered[index]! ^ 1;
      expect(() => prepareFundingTransaction(altered, consent), `byte ${index}`).toThrow();
    }
  });

  it("rejects invalid approved amounts, key widths and overlapping account roles", () => {
    for (const amount of [0n, -1n, 1n << 64n, 1 as unknown as bigint]) {
      expect(() => prepareFundingTransaction(wire(fixture()), { ...approval(), asset: { kind: "sol", lamports: amount } })).toThrow(/positive u64/);
    }
    expect(() => prepareFundingTransaction(wire(fixture()), { ...approval(), funder: new Uint8Array(31) })).toThrow(/32-byte/);
    expect(() => prepareFundingTransaction(wire(fixture()), { ...approval(), recentBlockhash: new Uint8Array(32) })).toThrow(/blockhash/);
    expect(() => prepareFundingTransaction(wire(fixture()), { ...approval(), funder: pocket.toBytes() })).toThrow(/overlapping/);
  });

  it("works without the Node Buffer global", () => {
    const tx = Uint8Array.from(wire(fixture(true))), consent = approval(true), saved = globalThis.Buffer;
    try {
      globalThis.Buffer = undefined as unknown as typeof Buffer;
      expect(prepareFundingTransaction(tx, consent).length).toBe(tx.length);
    } finally { globalThis.Buffer = saved; }
  });
});
