import { createHash } from "node:crypto";
import { bytesToHex, hexToBytes, intentHash, type Intent } from "@ghostlink/common";
import type { IntentParams, SignedIntent } from "@ghostlink/sdk";
import type { BotConsent } from "./types.js";

export type BotIntentParams = Omit<IntentParams, "nonce">;
export interface BotOrderStatus {
  requestKey: string;
  consentId: string;
  nonce: string;
  intentHashHex: string;
  /** Local state only; signed does not mean submitted or confirmed. */
  state: "reserved" | "signed" | "cancelled";
}

export interface StoredOrder extends BotOrderStatus {
  fingerprint: string;
  consentHash: string;
  intent: { pocket: string; nonce: string; inMint: string; inMax: string; outMint: string;
    outMin: string; deadlineSlot: string; policyHash: string };
  signatureHex?: string;
}

export const U64_MAX = (1n << 64n) - 1n;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const consentHash = (consent: BotConsent) => digest(JSON.stringify(consent));
export const orderScope = (c: BotConsent) => JSON.stringify([c.deployment.genesisHash, c.deployment.pocketProgram, c.pocket]);
export function padded(n: bigint): string {
  // One extra value represents exhaustion; it can never be signed as a nonce.
  if (n < 0n || n > U64_MAX + 1n) throw new Error("invalid nonce counter");
  return n.toString().padStart(20, "0");
}
export function counter(value: string): bigint {
  if (!/^\d{20}$/.test(value) || padded(BigInt(value)) !== value) throw new Error("invalid nonce counter");
  return BigInt(value);
}

/** Snapshot and validate before the first asynchronous chain read or durable reservation. */
export function copyParams(params: BotIntentParams): BotIntentParams {
  const copy = { inMint: params.inMint.slice(), inMax: params.inMax, outMint: params.outMint.slice(),
    outMin: params.outMin, deadlineSlot: params.deadlineSlot };
  if (copy.inMint.length !== 32 || copy.outMint.length !== 32 ||
      [copy.inMax, copy.outMin, copy.deadlineSlot].some(n => typeof n !== "bigint" || n < 0n || n > U64_MAX) ||
      copy.inMax === 0n || copy.outMin === 0n) throw new Error("invalid intent amounts, mints or deadline");
  return copy;
}
export function orderFingerprint(consent: BotConsent, params: BotIntentParams, explicitNonce?: bigint): string {
  return digest(JSON.stringify([consentHash(consent), bytesToHex(params.inMint), params.inMax.toString(),
    bytesToHex(params.outMint), params.outMin.toString(), params.deadlineSlot.toString(), explicitNonce?.toString() ?? null]));
}
export function encodeIntent(i: Intent): StoredOrder["intent"] {
  return { pocket: bytesToHex(i.pocket), nonce: i.nonce.toString(), inMint: bytesToHex(i.inMint), inMax: i.inMax.toString(),
    outMint: bytesToHex(i.outMint), outMin: i.outMin.toString(), deadlineSlot: i.deadlineSlot.toString(), policyHash: bytesToHex(i.policyHash) };
}
export function decodeIntent(i: StoredOrder["intent"]): Intent {
  return { pocket: hexToBytes(i.pocket), nonce: BigInt(i.nonce), inMint: hexToBytes(i.inMint), inMax: BigInt(i.inMax),
    outMint: hexToBytes(i.outMint), outMin: BigInt(i.outMin), deadlineSlot: BigInt(i.deadlineSlot), policyHash: hexToBytes(i.policyHash) };
}
export function orderStatus(order: StoredOrder): BotOrderStatus {
  const { requestKey, consentId, nonce, intentHashHex, state } = order;
  return { requestKey, consentId, nonce, intentHashHex, state };
}
export function signedOrder(order: StoredOrder): SignedIntent {
  if (order.state !== "signed" || !order.signatureHex) throw new Error("order is not signed");
  const intent = decodeIntent(order.intent), hash = intentHash(intent);
  if (bytesToHex(hash) !== order.intentHashHex) throw new Error("stored intent hash mismatch");
  return { intent, hash, signature: { signature: hexToBytes(order.signatureHex) } };
}
