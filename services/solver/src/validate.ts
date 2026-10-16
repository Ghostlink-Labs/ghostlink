/**
 * Local intent validation: the same checks the pocket program will make,
 * run before any fee is spent. Rebuilds the canonical bytes with
 * @ghostlink/common (vector-locked) and verifies the session signature.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import { hexToBytes, intentHash, type Intent, type IntentRequest } from "@ghostlink/common";

export interface ValidatedIntent {
  intent: Intent;
  hash: Uint8Array;
  sessionKind: 0 | 1;
  sessionKey: Uint8Array;
  signature: Uint8Array;
  webauthn?: { authenticatorData: Uint8Array; clientDataJson: Uint8Array };
}

export function validateIntent(req: IntentRequest): ValidatedIntent {
  if (!req || typeof req !== "object" || (req.sessionKind !== 0 && req.sessionKind !== 1)) {
    throw new Error("sessionKind must be 0 or 1");
  }
  for (const field of ["nonce", "inMax", "outMin", "deadlineSlot"] as const) {
    if (typeof req[field] !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(req[field])) {
      throw new Error(`${field} must be a canonical u64 decimal string`);
    }
  }
  const intent: Intent = {
    pocket: bs58.decode(req.pocket),
    nonce: BigInt(req.nonce),
    inMint: bs58.decode(req.inMint),
    inMax: BigInt(req.inMax),
    outMint: bs58.decode(req.outMint),
    outMin: BigInt(req.outMin),
    deadlineSlot: BigInt(req.deadlineSlot),
    policyHash: hexToBytes(req.policyHashHex),
  };
  const hash = intentHash(intent);
  const signature = hexToBytes(req.signatureHex);
  const sessionKey = hexToBytes(req.sessionKeyHex);

  if (req.sessionKind === 0) {
    if (sessionKey.length !== 32) throw new Error("ed25519 session key must be 32 bytes");
    if (!ed25519.verify(signature, hash, sessionKey)) {
      throw new Error("session signature does not verify");
    }
    return { intent, hash, sessionKind: 0, sessionKey, signature };
  }

  // P-256 / WebAuthn path: the signed message is authData || SHA-256(cdj)
  // and the clientDataJSON challenge must be the intent hash.
  if (sessionKey.length !== 33) throw new Error("p256 session key must be 33 bytes compressed");
  if (!req.webauthn) throw new Error("webauthn data required for passkey sessions");
  const authData = hexToBytes(req.webauthn.authenticatorDataHex);
  if (authData.length < 37 || (authData[32]! & 0x05) !== 0x05) {
    throw new Error("webauthn assertion must carry user-presence and user-verification");
  }
  const cdj = new TextEncoder().encode(req.webauthn.clientDataJsonUtf8);
  // Same parse as programs/pocket/src/precompile.rs: a webauthn.get type
  // and the FIRST "challenge" field, which must be the intent hash.
  const json = req.webauthn.clientDataJsonUtf8;
  if (!json.includes('"type":"webauthn.get"')) throw new Error("webauthn clientDataJSON is not a webauthn.get");
  const tag = '"challenge":"';
  const start = json.indexOf(tag);
  if (start < 0) throw new Error("webauthn clientDataJSON has no challenge");
  const end = json.indexOf('"', start + tag.length);
  if (end < 0 || json.slice(start + tag.length, end) !== base64url(hash)) {
    throw new Error("webauthn challenge does not match the intent");
  }
  const message = new Uint8Array(authData.length + 32);
  message.set(authData, 0);
  message.set(sha256(cdj), authData.length);
  // ECDSA verifies over SHA-256(message), exactly what the precompile does.
  if (!p256.verify(signature, sha256(message), sessionKey)) {
    throw new Error("passkey signature does not verify");
  }
  return {
    intent,
    hash,
    sessionKind: 1,
    sessionKey,
    signature,
    webauthn: { authenticatorData: authData, clientDataJson: cdj },
  };
}

function base64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}
