/**
 * Server-side login verification (build plan 4.2 step 7, off-chain path).
 *
 * In plain language: an app's backend calls `verifyLogin` with the proof
 * its frontend received. The function checks the zero-knowledge proof
 * itself, that it was made for YOUR domain (not another app's), that the
 * claims match what you asked for, that the Merkle roots inside it are
 * real recent roots, and — if you tell it which session key and expiry
 * the client announced — that the proof is bound to exactly those and
 * dies with its expiry. Session details are public: the backend must ALSO
 * verify a fresh, single-use challenge signed by that session key before
 * granting access. Binding alone does not prevent captured-proof replay.
 *
 * A proof is not a password: without `expect.session` any copy of it
 * logs in until its roots fall out of the ring. Set it, and have the
 * client additionally sign a nonce you issued with the session key.
 */
import * as snarkjs from "snarkjs";
export { loginChallengeDigest } from "@ghostlink/common";
import { createRequire } from "node:module";
import {
  FIELD_PRIME,
  domainHash,
  homeHash,
  sessionCommitment,
  type RootsResponse,
} from "@ghostlink/common";

/** Public signal order of the login circuit — the protocol contract. */
export const LOGIN_SIGNALS = [
  "registry_root",
  "census_root",
  "domain_hash",
  "app_id",
  "mint_hi",
  "mint_lo",
  "threshold",
  "min_slot",
  "session_commitment",
  "home_hash",
  "claim_holdings",
] as const;

type SignalName = (typeof LOGIN_SIGNALS)[number];
type Signals = Record<SignalName, bigint>;

/** ~24 hours of slots; the longest session the default policy allows. */
export const DEFAULT_MAX_SESSION_SLOTS = 216_000n;

export type RootSource = string | (() => Promise<{ registry: string[]; census: string[] }>);

export interface SessionExpectation {
  /**
   * 32 bytes of session key material as the pocket sees it: the Ed25519
   * public key itself, or SHA-256 of the 33-byte compressed P-256 key.
   */
  key32: Uint8Array;
  /** The expiry slot the client announced for this session. */
  expirySlot: bigint;
  /** The chain's current slot — fetch it yourself, never from the client. */
  currentSlot: bigint;
  /** Longest session you accept; default `DEFAULT_MAX_SESSION_SLOTS`. */
  maxSessionSlots?: bigint;
}

export interface VerifyLoginParams {
  /** The SDK's `session.proof.snarkjsProof`, not its on-chain proof bytes. */
  proof: object;
  /** The 11 public signals, canonical decimal strings, in circuit order. */
  publicSignals: string[];
  /** Your app's origin, e.g. "https://app.example.com". */
  expectedDomain: string;
  /**
   * The login verifying key. Defaults to the key bundled with this
   * package (`bundledLoginVerificationKey()`); pass your own only when
   * you verify against a different circuit build on purpose.
   */
  verificationKey?: object;
  /**
   * Where known roots come from: an indexer base URL, or a function —
   * for instance one that reads the 128-root ring straight from the
   * on-chain TreeState account. Required: a proof against a tree nobody
   * recognizes proves nothing. (`indexer` is the older name.)
   */
  roots?: RootSource;
  indexer?: RootSource;
  /** Skip the root check. Only for tests; never in production. */
  allowUnverifiedRoots?: boolean;
  expect?: {
    holdsAtLeast?: { mintHi: string; mintLo: string; threshold: bigint };
    /** Oldest acceptable census snapshot; only meaningful with `holdsAtLeast`. */
    minSlot?: bigint;
    /** Binds the proof to one session key + expiry and enforces the expiry. */
    session?: SessionExpectation;
    /** The home address the client announced (32 bytes). */
    home?: Uint8Array;
  };
  fetchFn?: typeof fetch;
}

export interface VerifyLoginResult {
  ok: boolean;
  /** The user's stable ID for THIS app as a canonical decimal string. */
  appId?: string;
  reason?: string;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = (1n << 64n) - 1n;

function parseSignals(raw: unknown): Signals | null {
  if (!Array.isArray(raw) || raw.length !== LOGIN_SIGNALS.length) return null;
  const out = {} as Signals;
  for (const [i, name] of LOGIN_SIGNALS.entries()) {
    const v = parseField(raw[i]);
    if (v === null) return null;
    out[name] = v;
  }
  return out;
}

function parseField(s: unknown): bigint | null {
  if (typeof s !== "string" || s.length > 77 || !DECIMAL.test(s)) return null;
  const v = BigInt(s);
  return v < FIELD_PRIME ? v : null;
}

export async function verifyLogin(params: VerifyLoginParams): Promise<VerifyLoginResult> {
  // This boundary is routinely called with decoded request data. Its
  // TypeScript types cannot guarantee the runtime shape of that data.
  try {
    return await verifyLoginChecked(params);
  } catch {
    return { ok: false, reason: "malformed login input" };
  }
}

async function verifyLoginChecked(params: VerifyLoginParams): Promise<VerifyLoginResult> {
  const signals = parseSignals(params.publicSignals);
  if (!signals) return { ok: false, reason: "malformed public signals" };
  if (typeof params.expectedDomain !== "string" || !params.expectedDomain) {
    return { ok: false, reason: "expected domain is required" };
  }

  // 1. The proof is bound to YOUR domain, or it is someone else's login.
  if (signals.domain_hash !== domainHash(params.expectedDomain)) {
    return { ok: false, reason: "proof bound to a different domain" };
  }

  // 2. Claim expectations.
  const want = params.expect?.holdsAtLeast;
  if (want) {
    if (typeof want.threshold !== "bigint" || want.threshold < 0n || want.threshold > MAX_U64) {
      return { ok: false, reason: "expected threshold must be a u64 bigint" };
    }
    if (signals.claim_holdings !== 1n) return { ok: false, reason: "holdings claim missing" };
    const hi = parseField(want.mintHi);
    const lo = parseField(want.mintLo);
    if (hi === null || lo === null) return { ok: false, reason: "malformed expected mint" };
    if (signals.mint_hi !== hi || signals.mint_lo !== lo) {
      return { ok: false, reason: "claim is for a different mint" };
    }
    if (signals.threshold < want.threshold) {
      return { ok: false, reason: "threshold below requirement" };
    }
  }
  if (params.expect?.minSlot !== undefined) {
    if (typeof params.expect.minSlot !== "bigint" || params.expect.minSlot < 0n || params.expect.minSlot > MAX_U64) {
      return { ok: false, reason: "expected minSlot must be a u64 bigint" };
    }
    // The circuit only enforces slot >= min_slot when the claim is on;
    // without it min_slot is whatever the prover typed.
    if (signals.claim_holdings !== 1n) {
      return { ok: false, reason: "minSlot is meaningless without a holdings claim" };
    }
    if (signals.min_slot < params.expect.minSlot) {
      return { ok: false, reason: "snapshot window too old" };
    }
  }

  // 3. Session binding and expiry (replay control).
  const session = params.expect?.session;
  if (session) {
    if (!(session.key32 instanceof Uint8Array) || session.key32.length !== 32) {
      return { ok: false, reason: "session key32 must be 32 bytes" };
    }
    const max = session.maxSessionSlots ?? DEFAULT_MAX_SESSION_SLOTS;
    if (![session.expirySlot, session.currentSlot, max].every((v) => typeof v === "bigint" && v >= 0n && v <= MAX_U64)) {
      return { ok: false, reason: "session slots must be u64 bigints" };
    }
    if (signals.session_commitment !== sessionCommitment(session.key32, session.expirySlot)) {
      return { ok: false, reason: "proof bound to a different session key or expiry" };
    }
    if (session.expirySlot <= session.currentSlot) return { ok: false, reason: "session expired" };
    if (session.expirySlot > session.currentSlot + max) {
      return { ok: false, reason: "session expiry too far ahead" };
    }
  }
  if (params.expect?.home) {
    if (!(params.expect.home instanceof Uint8Array) || params.expect.home.length !== 32) {
      return { ok: false, reason: "home must be 32 bytes" };
    }
    if (signals.home_hash !== homeHash(params.expect.home)) {
      return { ok: false, reason: "proof bound to a different home address" };
    }
  }

  // 4. Roots must be known recent roots (stale-root control).
  const source = params.roots ?? params.indexer;
  if (!source) {
    if (!params.allowUnverifiedRoots) {
      return { ok: false, reason: "no root source configured (roots: indexer URL or function)" };
    }
  } else {
    let roots: { registry: string[]; census: string[] };
    try {
      roots = typeof source === "function" ? await source() : await fetchRoots(source, params.fetchFn ?? fetch);
    } catch (e) {
      return { ok: false, reason: `root source unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!Array.isArray(roots?.registry) || !Array.isArray(roots?.census)) {
      return { ok: false, reason: "root source returned an unexpected shape" };
    }
    if (!roots.registry.some((r) => parseField(r) === signals.registry_root)) {
      return { ok: false, reason: "unknown registry root" };
    }
    if (signals.claim_holdings === 1n && !roots.census.some((r) => parseField(r) === signals.census_root)) {
      return { ok: false, reason: "unknown census root" };
    }
  }

  // 5. The proof itself.
  let valid = false;
  try {
    valid = await snarkjs.groth16.verify(
      params.verificationKey ?? bundledLoginVerificationKey(),
      params.publicSignals,
      params.proof,
    );
  } catch {
    return { ok: false, reason: "proof is malformed" };
  }
  if (!valid) return { ok: false, reason: "proof failed verification" };

  return { ok: true, appId: signals.app_id.toString() };
}

let bundledKey: object | undefined;

/** The login verifying key shipped with this package (keys/login_vk.json). */
export function bundledLoginVerificationKey(): object {
  if (!bundledKey) {
    const require = createRequire(import.meta.url);
    bundledKey = require("../keys/login_vk.json") as object;
  }
  return bundledKey;
}

async function fetchRoots(
  base: string,
  fetchFn: typeof fetch,
): Promise<{ registry: string[]; census: string[] }> {
  const get = async (tree: string): Promise<RootsResponse> => {
    const res = await fetchFn(`${base}/roots/${tree}`);
    if (!res.ok) throw new Error(`roots/${tree}: HTTP ${res.status}`);
    return (await res.json()) as RootsResponse;
  };
  const [registry, census] = await Promise.all([get("registry"), get("census")]);
  return { registry: registry.roots, census: census.roots };
}
