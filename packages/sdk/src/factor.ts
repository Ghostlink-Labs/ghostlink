/**
 * A device-held second factor for the identity secret, from the WebAuthn
 * PRF extension: the passkey evaluates a pseudo-random function over a
 * fixed salt, and only an authenticator holding that passkey (or a
 * platform it syncs to) can reproduce the output. Mixed into the secret
 * (identity.ts), it means a phished wallet signature alone is useless.
 *
 * Browser-only. Not every authenticator supports PRF; callers feature-
 * detect with `prfAvailable()` and fall back to signature-only with a
 * clear warning. Nothing here is persisted by the SDK: discoverable
 * credentials let the authenticator find the passkey by itself.
 */
import { sha256 } from "@noble/hashes/sha256";

const PRF_SALT = sha256(new TextEncoder().encode("ghostlink:identity-factor:v1"));

export interface PasskeyFactorOptions {
  /** Relying-party id (the site's host); defaults to the current host. */
  rpId?: string;
  /** Shown by the platform when creating the passkey. */
  userName: string;
  /** Stable per-user handle (any 1–64 bytes, e.g. the wallet address bytes). */
  userId: Uint8Array;
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

function available(): boolean {
  return typeof navigator !== "undefined" && !!navigator.credentials && typeof PublicKeyCredential !== "undefined";
}

/** True when this browser exposes WebAuthn at all; PRF itself is only known after a call. */
export function prfAvailable(): boolean {
  return available();
}

function buffer(u: Uint8Array): ArrayBuffer {
  return u.slice().buffer as ArrayBuffer;
}

/**
 * Evaluates the PRF with an existing GhostLink passkey. Throws when there
 * is none or the authenticator does not support PRF; `createPasskeyFactor`
 * makes one.
 */
export async function passkeyFactor(rpId?: string, credentialId?: Uint8Array): Promise<Uint8Array> {
  if (!available()) throw new Error("WebAuthn is not available in this environment");
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId,
      allowCredentials: credentialId ? [{ type: "public-key", id: buffer(credentialId) }] : [],
      userVerification: "required",
      extensions: { prf: { eval: { first: buffer(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no passkey was selected");
  const out = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!out) throw new Error("this passkey does not support the PRF extension");
  return sha256(new Uint8Array(out));
}

/**
 * Creates a discoverable GhostLink passkey with PRF enabled and returns
 * its first evaluation. Some platforms only evaluate PRF on `get`, so this
 * falls back to one immediately after creation.
 */
export async function createPasskeyFactor(options: PasskeyFactorOptions): Promise<Uint8Array> {
  if (!available()) throw new Error("WebAuthn is not available in this environment");
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "GhostLink", id: options.rpId },
      user: { id: buffer(options.userId), name: options.userName, displayName: options.userName },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: buffer(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey creation was cancelled");
  const results = cred.getClientExtensionResults() as PrfResults;
  if (results.prf?.enabled === false) throw new Error("this authenticator does not support the PRF extension");
  const first = results.prf?.results?.first;
  if (first) return sha256(new Uint8Array(first));
  // A discoverable get() could select an older credential and derive a
  // different permanent identity from the passkey just created.
  return passkeyFactor(options.rpId, new Uint8Array(cred.rawId));
}

/**
 * Gets the factor from an existing passkey, creating one when the user has
 * none yet. The platform's "no passkeys" refusal is what triggers creation.
 */
export async function obtainPasskeyFactor(options: PasskeyFactorOptions): Promise<Uint8Array> {
  try {
    return await passkeyFactor(options.rpId);
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "NotAllowedError" || name === "InvalidStateError") {
      return createPasskeyFactor(options);
    }
    throw e;
  }
}
