/**
 * Registration: the only moment a wallet ever signs (build plan 4.1).
 *
 * The identity secret is SHA-256 of the wallet's deterministic Ed25519
 * signature over the GhostLink sign-in message — a Sign-In-With-Solana
 * message whose first line names GhostLink's own domain. Wallets that
 * implement `solana:signIn` render that domain and warn when a page
 * other than the named one asks for the signature, which is what makes
 * the secret hard to phish; wallets without it sign the identical bytes
 * through `signMessage`, so the same wallet always yields the same
 * secret either way.
 *
 * An optional device-held second factor (see factor.ts) is mixed into
 * the secret so a signature alone cannot reproduce it. The wallet signs
 * twice: matching signatures prove the wallet is deterministic (RFC
 * 8032), which is what makes recovery "sign again on a new device".
 * Non-deterministic signers are refused unless the caller opts in.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import {
  Cluster,
  FieldElement,
  IDENTITY_STATEMENT,
  commitment,
  pk,
  registrationMessage,
  secretToField,
} from "@ghostlink/common";

export interface SignMessageFn {
  (message: Uint8Array): Promise<Uint8Array>;
}

/** The Wallet Standard `solana:signIn` input (Sign-In-With-Solana). */
export interface SolanaSignInInput {
  domain?: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

export interface SignInFn {
  (input: SolanaSignInInput): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }>;
}

/** What a wallet offers: native sign-in when it has it, plain signing always. */
export interface IdentitySigner {
  signMessage: SignMessageFn;
  signIn?: SignInFn;
}

export interface DerivedIdentity {
  /** The raw 32-byte secret. Keep encrypted at rest; never send anywhere. */
  secret: Uint8Array;
  /** The secret as a field element (what every hash uses). */
  sField: FieldElement;
  /** C = Poseidon(s, 0), the value that goes on-chain. */
  commitment: FieldElement;
  /** True when the secret is recoverable by signing again. */
  deterministic: boolean;
  /** How the wallet signed: native sign-in (domain shown by the wallet) or plain signMessage. */
  method: "signIn" | "signMessage";
  /** True when a device-held second factor was mixed in. */
  withFactor: boolean;
}

export interface DeriveIdentityOptions {
  /** Cluster the identity is for; part of the signed text (Chain ID). */
  cluster: Cluster;
  /** GhostLink's own host, e.g. "app.ghostlink.dev" — the domain wallets show and check. */
  domain: string;
  /** The signing wallet's base58 address; part of the signed text. */
  address: string;
  /** 32 bytes from a device-held factor (factor.ts); omit for signature-only. */
  secondFactor?: Uint8Array;
  /**
   * Accept a random secret when the wallet does not sign
   * deterministically. Only set this if you store an encrypted backup of
   * `secret` before registering — nothing else can ever recover it.
   */
  allowNonDeterministic?: boolean;
  /** Injectable for tests. */
  randomBytes?: (n: number) => Uint8Array;
}

export class NonDeterministicSignerError extends Error {
  constructor() {
    super(
      "this wallet does not sign deterministically, so a GhostLink identity derived from it " +
        "could never be recovered; use a wallet that does, or pass allowNonDeterministic " +
        "and store an encrypted backup of the secret before registering",
    );
    this.name = "NonDeterministicSignerError";
  }
}

const FACTOR_TAG = new TextEncoder().encode("ghostlink:identity:factor:v1");

/** SIWS chain ids (the standard's names, not cluster names). */
export function chainIdFor(cluster: Cluster): string {
  return cluster === "mainnet-beta" ? "mainnet" : cluster;
}

/** The sign-in input GhostLink sends; every field fixed so the text is stable. */
export function identitySignInInput(o: Pick<DeriveIdentityOptions, "cluster" | "domain" | "address">): SolanaSignInInput {
  return {
    domain: o.domain,
    address: o.address,
    statement: IDENTITY_STATEMENT,
    uri: `https://${o.domain}`,
    version: "1",
    chainId: chainIdFor(o.cluster),
  };
}

/**
 * The Sign-In-With-Solana message text, serialized exactly as the
 * Wallet Standard reference does (`createSignInMessageText`), so the
 * `signMessage` fallback signs the very bytes a native sign-in would.
 */
export function signInMessageText(input: SolanaSignInInput): string {
  let message = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`;
  if (input.statement) message += `\n\n${input.statement}`;
  const fields: string[] = [];
  if (input.uri) fields.push(`URI: ${input.uri}`);
  if (input.version) fields.push(`Version: ${input.version}`);
  if (input.chainId) fields.push(`Chain ID: ${input.chainId}`);
  if (input.nonce) fields.push(`Nonce: ${input.nonce}`);
  if (input.issuedAt) fields.push(`Issued At: ${input.issuedAt}`);
  if (input.expirationTime) fields.push(`Expiration Time: ${input.expirationTime}`);
  if (input.notBefore) fields.push(`Not Before: ${input.notBefore}`);
  if (input.requestId) fields.push(`Request ID: ${input.requestId}`);
  if (input.resources) {
    fields.push("Resources:");
    for (const r of input.resources) fields.push(`- ${r}`);
  }
  if (fields.length > 0) message += `\n\n${fields.join("\n")}`;
  return message;
}

/** The exact bytes the wallet is asked to sign for an identity. */
export function identityMessageBytes(o: Pick<DeriveIdentityOptions, "cluster" | "domain" | "address">): Uint8Array {
  return new TextEncoder().encode(signInMessageText(identitySignInInput(o)));
}

/**
 * Derives the identity secret. Prefers the wallet's native sign-in (the
 * wallet shows GhostLink's domain and warns if another page asks);
 * falls back to `signMessage` over the identical bytes. Throws
 * `NonDeterministicSignerError` when two signatures over the same bytes
 * differ, unless the caller opted into a random secret.
 */
export async function deriveIdentity(
  signer: SignMessageFn | IdentitySigner,
  options: DeriveIdentityOptions,
): Promise<DerivedIdentity> {
  const s: IdentitySigner = typeof signer === "function" ? { signMessage: signer } : signer;
  const walletKey = pk(options.address);
  if (walletKey.length !== 32) throw new Error("wallet address must encode 32 bytes");
  const expected = identityMessageBytes(options);
  let sig1: Uint8Array;
  let sig2: Uint8Array;
  let method: DerivedIdentity["method"] = "signMessage";

  if (s.signIn) {
    const input = identitySignInInput(options);
    const r1 = await s.signIn(input);
    // Only the fixed text is acceptable: a wallet that injects a nonce or
    // timestamp would make the secret unrepeatable, so use signMessage.
    if (equal(r1.signedMessage, expected)) {
      const r2 = await s.signIn(input);
      if (!equal(r2.signedMessage, expected)) throw new Error("wallet changed the sign-in text between two requests");
      sig1 = r1.signature;
      sig2 = r2.signature;
      method = "signIn";
    } else {
      sig1 = await s.signMessage(expected);
      sig2 = await s.signMessage(expected);
    }
  } else {
    sig1 = await s.signMessage(expected);
    sig2 = await s.signMessage(expected);
  }

  // Equal bytes alone do not establish a wallet signature: providers may
  // return empty bytes, sign with a changed account, or sign another message.
  // Never register a predictable or unrecoverable secret from those results.
  for (const signature of [sig1, sig2]) {
    if (!(signature instanceof Uint8Array) || signature.length !== 64 ||
      !ed25519.verify(signature, expected, walletKey, { zip215: false })) {
      throw new Error("wallet returned an invalid identity signature");
    }
  }
  const deterministic = equal(sig1, sig2);
  if (!deterministic && !options.allowNonDeterministic) throw new NonDeterministicSignerError();
  const base = deterministic ? sha256(sig1) : (options.randomBytes ?? defaultRandom)(32);
  const factor = options.secondFactor;
  if (factor && factor.length !== 32) throw new Error("secondFactor must be 32 bytes");
  const secret = factor ? sha256(concat(FACTOR_TAG, base, factor)) : base;
  const sField = secretToField(secret);
  return { secret, sField, commitment: commitment(sField), deterministic, method, withFactor: Boolean(factor) };
}

/** The registration bundle the relayer needs (it never sees the secret). */
export async function buildRegistration(
  identity: DerivedIdentity,
  walletPubkey: Uint8Array,
  registryProgramId: Uint8Array,
  cluster: Cluster,
  signMessage: SignMessageFn,
): Promise<{ message: Uint8Array; signature: Uint8Array }> {
  const message = registrationMessage({
    commitment: identity.commitment,
    walletPubkey,
    registryProgramId,
    cluster,
  });
  const signature = await signMessage(message);
  return { message, signature };
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
