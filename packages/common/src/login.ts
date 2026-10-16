import { sha256 } from "@noble/hashes/sha256";

const LOGIN_CHALLENGE_TAG = new TextEncoder().encode("ghostlink:login-challenge:v1");

/**
 * Domain-separated digest of a server-issued, single-use login nonce.
 * A backend must verify its signature under the proof-bound session key
 * and consume the nonce once. The tag prevents a chosen nonce from being
 * interpreted as an intent or owner-action digest by the same session.
 */
export function loginChallengeDigest(challenge: Uint8Array): Uint8Array {
  if (!(challenge instanceof Uint8Array) || challenge.length !== 32) {
    throw new Error("sign-in requires a 32-byte server challenge");
  }
  const bytes = new Uint8Array(LOGIN_CHALLENGE_TAG.length + challenge.length);
  bytes.set(LOGIN_CHALLENGE_TAG);
  bytes.set(challenge, LOGIN_CHALLENGE_TAG.length);
  return sha256(bytes);
}
