/**
 * Session signers (build plan 4.2 step 5).
 *
 * Software sessions are Ed25519 keypairs held in memory only — never
 * localStorage. Passkey sessions are WebAuthn ES256 credentials; the
 * pocket program verifies them through the secp256r1 precompile, and the
 * 32 bytes entering the session commitment are SHA-256 of the 33-byte
 * compressed public key.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { FieldElement, sessionCommitment } from "@ghostlink/common";

export const SESSION_KIND_ED25519 = 0 as const;
export const SESSION_KIND_P256 = 1 as const;
export type SessionKind = typeof SESSION_KIND_ED25519 | typeof SESSION_KIND_P256;

export interface SessionSigner {
  kind: SessionKind;
  /** 33 bytes as stored on-chain (ed25519 key + zero byte, or compressed P-256). */
  key33: Uint8Array;
  /** The 32 bytes entering Poseidon for the session commitment. */
  key32: Uint8Array;
  /** Signs a 32-byte digest; for passkeys this triggers the platform prompt. */
  sign(digest: Uint8Array): Promise<SessionSignature>;
}

export interface SessionSignature {
  signature: Uint8Array; // 64 bytes
  webauthn?: { authenticatorData: Uint8Array; clientDataJson: Uint8Array };
}

export function softwareSession(seed?: Uint8Array): SessionSigner {
  const secret = seed ?? randomBytes(32);
  const pub = ed25519.getPublicKey(secret);
  const key33 = new Uint8Array(33);
  key33.set(pub, 0);
  return {
    kind: SESSION_KIND_ED25519,
    key33,
    key32: pub,
    async sign(digest) {
      return { signature: ed25519.sign(digest, secret) };
    },
  };
}

export function sessionCommitmentFor(
  signer: Pick<SessionSigner, "key32">,
  expirySlot: bigint,
): FieldElement {
  return sessionCommitment(signer.key32, expirySlot);
}

/**
 * A passkey-backed session. Browser-only: creates (or reuses) a WebAuthn
 * credential whose public key the caller extracts at creation time.
 * `credentialId` and the compressed public key must be persisted by the
 * host app (they are public values).
 */
export function passkeySession(
  credentialId: Uint8Array,
  compressedPublicKey: Uint8Array,
): SessionSigner {
  if (compressedPublicKey.length !== 33) throw new Error("expected 33-byte compressed P-256 key");
  return {
    kind: SESSION_KIND_P256,
    key33: compressedPublicKey,
    key32: sha256(compressedPublicKey),
    async sign(digest) {
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: digest.slice().buffer as ArrayBuffer,
          allowCredentials: [{ type: "public-key", id: credentialId.slice().buffer as ArrayBuffer }],
          userVerification: "required",
        },
      })) as PublicKeyCredential;
      const resp = cred.response as AuthenticatorAssertionResponse;
      return {
        signature: normalizeDerToLowS(new Uint8Array(resp.signature)),
        webauthn: {
          authenticatorData: new Uint8Array(resp.authenticatorData),
          clientDataJson: new Uint8Array(resp.clientDataJSON),
        },
      };
    },
  };
}

/**
 * WebAuthn returns DER-encoded ECDSA signatures; the precompile wants raw
 * r||s with low S (it rejects high-S outright).
 */
export function normalizeDerToLowS(der: Uint8Array): Uint8Array {
  // Raw r||s is 64 bytes and may legitimately start with the DER tag 0x30.
  if (der.length === 64) return lowS(der);
  // DER: 0x30 len 0x02 rlen r 0x02 slen s
  if (der[0] !== 0x30) {
    throw new Error("unrecognized signature encoding");
  }
  let off = 2;
  if (der[1]! & 0x80) off = 2 + (der[1]! & 0x7f);
  const readInt = (): Uint8Array => {
    if (der[off] !== 0x02) throw new Error("bad DER");
    const len = der[off + 1];
    if (len === undefined || off + 2 + len > der.length) throw new Error("bad DER length");
    const v = der.subarray(off + 2, off + 2 + len);
    off += 2 + len;
    return v;
  };
  const r = readInt();
  const s = readInt();
  if (off !== der.length) throw new Error("trailing bytes after DER signature");
  const out = new Uint8Array(64);
  out.set(trimTo32(r), 0);
  out.set(trimTo32(s), 32);
  return lowS(out);
}

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function lowS(sig64: Uint8Array): Uint8Array {
  let s = 0n;
  for (const b of sig64.subarray(32)) s = (s << 8n) | BigInt(b);
  if (s === 0n || s >= P256_N) throw new Error("signature s out of range");
  if (s * 2n <= P256_N) return sig64;
  const out = sig64.slice();
  let v = P256_N - s;
  for (let i = 63; i >= 32; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function trimTo32(x: Uint8Array): Uint8Array {
  let i = 0;
  while (i < x.length - 1 && x[i] === 0) i++;
  const trimmed = x.subarray(i);
  if (trimmed.length > 32) throw new Error("component too long");
  const out = new Uint8Array(32);
  out.set(trimmed, 32 - trimmed.length);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
