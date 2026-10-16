/**
 * BN254 scalar-field encoding rules (build plan, section 5).
 *
 * Everything that enters a Poseidon hash or a circuit is a field element.
 * A 32-byte Solana key does not fit in 254 bits, so it is split into two
 * 128-bit halves. The same split is used in TypeScript, Rust and circom,
 * and fixtures/vectors.json pins it.
 */

/** BN254 scalar field prime (the order of the group Groth16 proves over). */
export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export type FieldElement = bigint;

export function mod(n: bigint, m: bigint = FIELD_PRIME): bigint {
  const r = n % m;
  return r < 0n ? r + m : r;
}

/** Big-endian bytes -> bigint. */
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

/** bigint -> fixed-length big-endian bytes. Throws if it does not fit. */
export function bigIntToBytesBE(n: bigint, length: number): Uint8Array {
  if (n < 0n) throw new Error("negative");
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`value does not fit in ${length} bytes`);
  return out;
}

/** A field element serialized as 32 big-endian bytes (the on-chain shape). */
export function fieldToBytes32(f: FieldElement): Uint8Array {
  if (f >= FIELD_PRIME) throw new Error("not a reduced field element");
  return bigIntToBytesBE(f, 32);
}

export function bytes32ToField(bytes: Uint8Array): FieldElement {
  if (bytes.length !== 32) throw new Error("expected 32 bytes");
  const n = bytesToBigIntBE(bytes);
  if (n >= FIELD_PRIME) throw new Error("bytes encode a value >= field prime");
  return n;
}

/**
 * Split a 32-byte value (pubkey, mint) into two field elements:
 * hi = bytes[0..16], lo = bytes[16..32], both big-endian.
 * Each half is < 2^128 < p, so no reduction is ever needed.
 */
export function splitBytes32(bytes: Uint8Array): { hi: FieldElement; lo: FieldElement } {
  if (bytes.length !== 32) throw new Error("expected 32 bytes");
  return {
    hi: bytesToBigIntBE(bytes.subarray(0, 16)),
    lo: bytesToBigIntBE(bytes.subarray(16, 32)),
  };
}

export function joinBytes32(hi: FieldElement, lo: FieldElement): Uint8Array {
  const out = new Uint8Array(32);
  out.set(bigIntToBytesBE(hi, 16), 0);
  out.set(bigIntToBytesBE(lo, 16), 16);
  return out;
}

/**
 * Interpret a 32-byte hash (SHA-256 output) as a field element by reducing
 * the big-endian integer mod p. Used for domain_hash and for the identity
 * secret `s` when it enters a Poseidon hash.
 */
export function hashToField(bytes: Uint8Array): FieldElement {
  if (bytes.length !== 32) throw new Error("expected 32 bytes");
  return mod(bytesToBigIntBE(bytes));
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("odd-length hex");
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error("not a hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
