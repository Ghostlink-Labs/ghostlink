/**
 * Precompile instruction builders: one signature, every offset pointing
 * into the instruction itself (the only shape the programs accept).
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const ED25519_PROGRAM = new PublicKey("Ed25519SigVerify111111111111111111111111111");
export const SECP256R1_PROGRAM = new PublicKey("Secp256r1SigVerify1111111111111111111111111");

function sigIx(program: PublicKey, pubkey: Uint8Array, signature: Uint8Array, message: Uint8Array) {
  if (signature.length !== 64) throw new Error("expected 64-byte signature");
  const header = 2 + 14;
  const pkOff = header;
  const sigOff = pkOff + pubkey.length;
  const msgOff = sigOff + 64;
  const data = Buffer.alloc(msgOff + message.length);
  data[0] = 1;
  data[1] = 0;
  const offsets = [sigOff, 0xffff, pkOff, 0xffff, msgOff, message.length, 0xffff];
  offsets.forEach((v, i) => data.writeUInt16LE(v, 2 + i * 2));
  data.set(pubkey, pkOff);
  data.set(signature, sigOff);
  data.set(message, msgOff);
  return new TransactionInstruction({ programId: program, keys: [], data });
}

export function ed25519Ix(pubkey32: Uint8Array, signature: Uint8Array, message: Uint8Array) {
  if (pubkey32.length !== 32) throw new Error("expected 32-byte key");
  return sigIx(ED25519_PROGRAM, pubkey32, signature, message);
}

export function secp256r1Ix(pubkey33: Uint8Array, signature: Uint8Array, message: Uint8Array) {
  if (pubkey33.length !== 33) throw new Error("expected 33-byte compressed key");
  return sigIx(SECP256R1_PROGRAM, pubkey33, signature, message);
}
