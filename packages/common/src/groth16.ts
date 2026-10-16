/**
 * snarkjs proof -> the byte shapes groth16-solana verifies on-chain.
 *
 * Rules (matching the crate's own converter, see programs/verifier):
 * - proof A is NEGATED (y -> Fq - y) and serialized as x||y, 32-byte
 *   big-endian each;
 * - proof B is x_c1||x_c0||y_c1||y_c0 (Fp2 c1 first), 32-byte BE each;
 * - proof C is x||y;
 * - every public input is one 32-byte BE field element.
 *
 * The committed fixture proofs carry bytes produced by exactly this code,
 * and the Rust test suite verifies those bytes through the on-chain
 * verifier — so this file is cross-tested against the programs.
 */
import { bigIntToBytesBE } from "./field.js";

/** BN254 base-field modulus Fq (NOT the scalar field). */
export const BASE_FIELD_PRIME =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export interface SnarkjsProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
}

export interface ProofBytes {
  a: Uint8Array; // 64
  b: Uint8Array; // 128
  c: Uint8Array; // 64
}

export function proofToBytes(proof: SnarkjsProof): ProofBytes {
  const ax = BigInt(proof.pi_a[0]);
  const ay = BigInt(proof.pi_a[1]);
  const negAy = ay === 0n ? 0n : BASE_FIELD_PRIME - (ay % BASE_FIELD_PRIME);

  const a = new Uint8Array(64);
  a.set(bigIntToBytesBE(ax, 32), 0);
  a.set(bigIntToBytesBE(negAy, 32), 32);

  const b = new Uint8Array(128);
  b.set(bigIntToBytesBE(BigInt(proof.pi_b[0][1]), 32), 0);
  b.set(bigIntToBytesBE(BigInt(proof.pi_b[0][0]), 32), 32);
  b.set(bigIntToBytesBE(BigInt(proof.pi_b[1][1]), 32), 64);
  b.set(bigIntToBytesBE(BigInt(proof.pi_b[1][0]), 32), 96);

  const c = new Uint8Array(64);
  c.set(bigIntToBytesBE(BigInt(proof.pi_c[0]), 32), 0);
  c.set(bigIntToBytesBE(BigInt(proof.pi_c[1]), 32), 32);

  return { a, b, c };
}

/** Public signals (decimal strings) -> 32-byte BE field elements. */
export function publicSignalsToBytes(signals: string[]): Uint8Array[] {
  return signals.map((s) => bigIntToBytesBE(BigInt(s), 32));
}
