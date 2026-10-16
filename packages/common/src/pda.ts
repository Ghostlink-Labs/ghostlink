/**
 * Program-derived address computation without pulling in web3.js.
 * PDA = SHA-256(seed_1 || ... || seed_n || bump || program_id || "ProgramDerivedAddress"),
 * walking bump down from 255 until the result is off the ed25519 curve.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { fieldToBytes32, FieldElement } from "./field.js";
import { POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID, CENSUS_PROGRAM_ID } from "./constants.js";

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

export function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): { address: Uint8Array; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, new Uint8Array([bump]), programId, PDA_MARKER];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.length;
    }
    const candidate = sha256(buf);
    if (!isOnCurve(candidate)) return { address: candidate, bump };
  }
  throw new Error("no viable bump");
}

const te = new TextEncoder();
export const pk = (base58: string): Uint8Array => bs58.decode(base58);
export const toBase58 = (bytes: Uint8Array): string => bs58.encode(bytes);

/** Registry: the single tree state account. */
export function registryTreePda(programId: Uint8Array = pk(REGISTRY_PROGRAM_ID)) {
  return findProgramAddress([te.encode("tree")], programId);
}

/** Registry: one binding per wallet. */
export function bindingPda(wallet: Uint8Array, programId: Uint8Array = pk(REGISTRY_PROGRAM_ID)) {
  return findProgramAddress([te.encode("binding"), wallet], programId);
}

/** Census: the single tree state account. */
export function censusTreePda(programId: Uint8Array = pk(CENSUS_PROGRAM_ID)) {
  return findProgramAddress([te.encode("census")], programId);
}

/** Pocket: one pocket per app_id (app_id as 32 big-endian bytes). */
export function pocketPda(appId: FieldElement, programId: Uint8Array = pk(POCKET_PROGRAM_ID)) {
  return findProgramAddress([te.encode("pocket"), fieldToBytes32(appId)], programId);
}

/** Pocket: transient fill state for one intent, seeded by its nonce (u64 LE). */
export function fillStatePda(
  pocket: Uint8Array,
  nonce: bigint,
  programId: Uint8Array = pk(POCKET_PROGRAM_ID),
) {
  if (nonce < 0n || nonce > 0xffffffffffffffffn) throw new Error("nonce out of u64 range");
  const le = new Uint8Array(8);
  let v = nonce;
  for (let i = 0; i < 8; i++) {
    le[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return findProgramAddress([te.encode("fill"), pocket, le], programId);
}
