/**
 * Pocket: funding, intents and the owner-authorized actions
 * (build plan 4.3–4.7).
 *
 * The SDK recomputes every pocket address from app_id client-side and
 * compares before displaying funding details and builds canonical intent
 * bytes itself. Policy enforcement, including passkey requirements for
 * big/no-oracle actions, lives in the on-chain program.
 */
import { sha256 } from "@noble/hashes/sha256";
import {
  FieldElement,
  Intent,
  Policy,
  bytesToHex,
  conservativePolicy,
  fieldToBytes32,
  intentHash,
  policyHash,
  pocketPda,
  toBase58,
  u64le,
} from "@ghostlink/common";
import type { SessionSigner, SessionSignature } from "./session.js";

export interface PocketHandle {
  appId: FieldElement;
  address: Uint8Array;
  policy: Policy;
  home: Uint8Array;
}

export function derivePocket(appId: FieldElement, home: Uint8Array, policy?: Policy): PocketHandle {
  return {
    appId,
    address: pocketPda(appId).address,
    policy: policy ?? conservativePolicy(),
    home,
  };
}

export interface FundingOptions {
  /** Solana Actions (Blink) URL served by our registered endpoint. */
  blinkUrl: string;
  /** Solana Pay transaction-request URL for QR flows. */
  solanaPayUrl: string;
  /** The raw pocket address for exchange withdrawals. */
  address: string;
}

export function fundingOptions(pocket: PocketHandle, actionsBase: string): FundingOptions {
  const address = toBase58(pocketPda(pocket.appId).address);
  if (toBase58(pocket.address) !== address) throw new Error("pocket address does not match app id");
  const appIdHex = bytesToHex(fieldToBytes32(pocket.appId));
  const blinkUrl = `${actionsBase.replace(/\/$/, "")}/actions/fund/${appIdHex}`;
  return {
    blinkUrl,
    solanaPayUrl: `solana:${encodeURIComponent(blinkUrl)}`,
    address,
  };
}

export interface IntentParams {
  nonce: bigint;
  inMint: Uint8Array;
  inMax: bigint;
  outMint: Uint8Array;
  outMin: bigint;
  deadlineSlot: bigint;
}

export interface SignedIntent {
  intent: Intent;
  hash: Uint8Array;
  signature: SessionSignature;
}

/** Builds canonical intent bytes, hashes and signs with the session. */
export async function signIntent(
  pocket: PocketHandle,
  session: SessionSigner,
  params: IntentParams,
): Promise<SignedIntent> {
  const intent: Intent = {
    pocket: pocket.address.slice(),
    nonce: params.nonce,
    inMint: params.inMint.slice(),
    inMax: params.inMax,
    outMint: params.outMint.slice(),
    outMin: params.outMin,
    deadlineSlot: params.deadlineSlot,
    policyHash: policyHash(pocket.policy),
  };
  const hash = intentHash(intent);
  const signature = await session.sign(hash.slice());
  return { intent, hash, signature };
}

/** Owner/session action digests bind the current on-chain owner action nonce. */
export function sweepDigest(pocketAddress: Uint8Array, ownerActionNonce: bigint): Uint8Array {
  return actionDigest("ghostlink:sweep:v1", pocketAddress, u64le(ownerActionNonce));
}

export function revokeDigest(pocketAddress: Uint8Array, ownerActionNonce: bigint): Uint8Array {
  return actionDigest("ghostlink:revoke:v1", pocketAddress, u64le(ownerActionNonce));
}

export function changeDigest(pocketAddress: Uint8Array, changeBorsh: Uint8Array, ownerActionNonce: bigint): Uint8Array {
  return actionDigest("ghostlink:change:v1", pocketAddress, sha256(changeBorsh), u64le(ownerActionNonce));
}

export function cancelDigest(pocketAddress: Uint8Array, changeBorsh: Uint8Array, ownerActionNonce: bigint): Uint8Array {
  return actionDigest("ghostlink:cancel:v1", pocketAddress, sha256(changeBorsh), u64le(ownerActionNonce));
}

/** borsh(Change::Home(newHome)) — enum tag 0 then the 32-byte key. */
export function changeHomeBorsh(newHome: Uint8Array): Uint8Array {
  if (newHome.length !== 32) throw new Error("expected 32-byte address");
  const out = new Uint8Array(33);
  out[0] = 0;
  out.set(newHome, 1);
  return out;
}

function actionDigest(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const tagBytes = new TextEncoder().encode(tag);
  const total = tagBytes.length + parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  buf.set(tagBytes, 0);
  let off = tagBytes.length;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return sha256(buf);
}
