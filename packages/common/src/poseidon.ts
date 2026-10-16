/**
 * Every Poseidon value in the protocol, in one place (build plan section 5).
 *
 * Poseidon here means the circomlib parameterisation over the BN254 scalar
 * field — the same parameters implemented by Solana's `sol_poseidon`
 * syscall (via light-poseidon) and by circomlib's Poseidon template, so one
 * value computed in any of the three stacks matches the other two.
 */
import { poseidon2, poseidon3, poseidon6 } from "poseidon-lite";
import { sha256 } from "@noble/hashes/sha256";
import {
  FieldElement,
  hashToField,
  splitBytes32,
} from "./field.js";
import { SEP_APP_ID, SEP_OWNER_TAG, TREE_DEPTH } from "./constants.js";

/** Identity secret (32 raw bytes) -> field element used in all hashes. */
export function secretToField(s: Uint8Array): FieldElement {
  return hashToField(s);
}

/** C = Poseidon(s, 0): the registered commitment to the identity secret. */
export function commitment(sField: FieldElement): FieldElement {
  return poseidon2([sField, 0n]);
}

/** L_reg = Poseidon(pk_hi, pk_lo, C): a registry tree leaf. */
export function registryLeaf(walletPubkey: Uint8Array, c: FieldElement): FieldElement {
  const { hi, lo } = splitBytes32(walletPubkey);
  return poseidon3([hi, lo, c]);
}

/** L_cen = Poseidon(pk_hi, pk_lo, mint_hi, mint_lo, amount, slot): a census leaf. */
export function censusLeaf(
  walletPubkey: Uint8Array,
  mint: Uint8Array,
  amount: bigint,
  slot: bigint,
): FieldElement {
  const pk = splitBytes32(walletPubkey);
  const m = splitBytes32(mint);
  return poseidon6([pk.hi, pk.lo, m.hi, m.lo, amount, slot]);
}

/** domain_hash = SHA-256(origin) mod p. The origin is the page origin string. */
export function domainHash(origin: string): FieldElement {
  return hashToField(sha256(new TextEncoder().encode(origin)));
}

/** app_id = Poseidon(s, domain_hash, 1): per-app identity, unlinkable across apps. */
export function appId(sField: FieldElement, domain: FieldElement): FieldElement {
  return poseidon3([sField, domain, SEP_APP_ID]);
}

/** owner_tag = Poseidon(s, domain_hash, 2): used only by the owner-proof circuit. */
export function ownerTag(sField: FieldElement, domain: FieldElement): FieldElement {
  return poseidon3([sField, domain, SEP_OWNER_TAG]);
}

/** session_commitment = Poseidon(spk_hi, spk_lo, expiry_slot). */
export function sessionCommitment(
  sessionPubkey: Uint8Array,
  expirySlot: bigint,
): FieldElement {
  const { hi, lo } = splitBytes32(sessionPubkey);
  return poseidon3([hi, lo, expirySlot]);
}

/** home_hash = Poseidon(home_hi, home_lo). */
export function homeHash(homeAddress: Uint8Array): FieldElement {
  const { hi, lo } = splitBytes32(homeAddress);
  return poseidon2([hi, lo]);
}

/** Internal Merkle node = Poseidon(left, right). */
export function merkleNode(left: FieldElement, right: FieldElement): FieldElement {
  return poseidon2([left, right]);
}

/**
 * Zero constants per level: zeros[0] = Poseidon(0,0) is the empty leaf, and
 * zeros[i+1] = Poseidon(zeros[i], zeros[i]). zeros[TREE_DEPTH] is the empty
 * tree's root. Published in fixtures/vectors.json.
 */
export function zeroHashes(depth: number = TREE_DEPTH): FieldElement[] {
  const zeros: FieldElement[] = [poseidon2([0n, 0n])];
  for (let i = 1; i <= depth; i++) {
    const below = zeros[i - 1]!;
    zeros.push(poseidon2([below, below]));
  }
  return zeros;
}
