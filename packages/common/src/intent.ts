/**
 * The intent schema: what an app may ask a pocket to do (build plan 4.4).
 *
 * An intent is never a transaction. Its canonical bytes are fixed here;
 * the session key signs SHA-256(canonical bytes), and the pocket program
 * recomputes the same hash from the same layout (vector-tested in Rust).
 *
 * Layout (179 bytes):
 *   "ghostlink:intent:v1" (19 ASCII bytes)
 *   pocket        32 bytes
 *   nonce         u64 LE
 *   in_mint       32 bytes
 *   in_max        u64 LE
 *   out_mint      32 bytes
 *   out_min       u64 LE
 *   deadline_slot u64 LE
 *   policy_hash   32 bytes
 */
import { sha256 } from "@noble/hashes/sha256";
import { INTENT_TAG } from "./constants.js";
import { bigIntToBytesBE } from "./field.js";

export interface Intent {
  /** Pocket PDA this intent spends from. */
  pocket: Uint8Array;
  /**
   * Any u64, once. The pocket keeps a sliding window of NONCE_WINDOW
   * values; a nonce beyond it moves the window forward and retires the
   * values left behind, so allocate from a counter you persist per pocket
   * and never reuse a smaller value.
   */
  nonce: bigint;
  inMint: Uint8Array;
  inMax: bigint;
  outMint: Uint8Array;
  outMin: bigint;
  deadlineSlot: bigint;
  /** Hash of the pocket policy the signer believed was in force. */
  policyHash: Uint8Array;
}

export interface OracleFeedBinding {
  /** The SPL mint this feed prices. */
  mint: Uint8Array;
  /** The 32-byte Pyth feed id for that mint. */
  feedId: Uint8Array;
  /** The mint's decimals, pinned here so valuation needs no mint account. */
  decimals: number;
}

/** Explicit owner permission for bounded buys and tracked exits without an asset price feed. */
export interface SpeculativePolicy {
  dailyBuyCapUsdE6: bigint;
  /** Historical committed capital, not current market value. */
  maxCostExposureUsdE6: bigint;
  /** 1..8. Each asset remains tied to its original base and token account. */
  maxPositions: number;
  /** 1..4 distinct, oracle-priced mints; each must also be an allowed output. */
  baseMints: Uint8Array[];
}

export interface Policy {
  dailyCapUsdE6: bigint;
  maxSlippageBps: number;
  bigActionThresholdUsdE6: bigint;
  noOracleCapUsdE6: bigint;
  /** Up to 8 mints; empty means any mint (subject to oracle rules). */
  allowedOutMints: Uint8Array[];
  sessionMaxSlots: bigint;
  /**
   * Which Pyth feed prices which mint, fixed by the user at pocket
   * creation and changed only through the 24-hour timelock. A mint
   * without a feed binding requires explicit speculative consent. Up to 8.
   */
  oracleFeeds: OracleFeedBinding[];
  /** Absent by default. Applies to software and passkey sessions alike. */
  speculative?: SpeculativePolicy;
}

function u64le(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error("u64 out of range");
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u16le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error("u16 out of range");
  return new Uint8Array([n & 0xff, n >> 8]);
}

function expect32(b: Uint8Array, what: string): Uint8Array {
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
}

export function intentBytes(intent: Intent): Uint8Array {
  const tag = new TextEncoder().encode(INTENT_TAG);
  const parts = [
    tag,
    expect32(intent.pocket, "pocket"),
    u64le(intent.nonce),
    expect32(intent.inMint, "inMint"),
    u64le(intent.inMax),
    expect32(intent.outMint, "outMint"),
    u64le(intent.outMin),
    u64le(intent.deadlineSlot),
    expect32(intent.policyHash, "policyHash"),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** What the session key actually signs. */
export function intentHash(intent: Intent): Uint8Array {
  return sha256(intentBytes(intent));
}

/**
 * Canonical policy bytes -> policy_hash.
 * Layout: "ghostlink:policy:v3" | daily_cap u64 LE | max_slippage_bps u16 LE | big_action u64 LE |
 *         no_oracle_cap u64 LE | session_max_slots u64 LE |
 *         allowed count u8 | each allowed mint, 32 bytes, in given order |
 *         feed count u8 | each binding as mint (32), feed id (32), decimals (1) |
 *         speculative flag u8; if 1: daily_buy u64 | max_cost u64 | max_positions u8 |
 *         base count u8 | each base mint (32). All integers are little endian.
 */
export function policyBytes(p: Policy): Uint8Array {
  if (p.allowedOutMints.length > 8) throw new Error("at most 8 allowed mints");
  if (p.oracleFeeds.length > 8) throw new Error("at most 8 oracle feeds");
  u16le(p.maxSlippageBps);
  if (p.maxSlippageBps > 10_000) throw new Error("slippage exceeds 10000 bps");
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (p.oracleFeeds.some((f, i) => p.oracleFeeds.slice(0, i).some(prior => same(f.mint, prior.mint)))) {
    throw new Error("duplicate oracle mint");
  }
  const s = p.speculative;
  if (s && (p.noOracleCapUsdE6 <= 0n || s.dailyBuyCapUsdE6 <= 0n || s.maxCostExposureUsdE6 <= 0n ||
    !Number.isInteger(s.maxPositions) || s.maxPositions < 1 || s.maxPositions > 8 ||
    !Array.isArray(s.baseMints) || s.baseMints.length < 1 || s.baseMints.length > 4 ||
    s.baseMints.some((mint, i) => s.baseMints.slice(0, i).some(prior => same(prior, mint)) ||
      !p.oracleFeeds.some(f => same(f.mint, mint)) ||
      (p.allowedOutMints.length > 0 && !p.allowedOutMints.some(m => same(m, mint)))))) {
    throw new Error("invalid speculative policy limits or bases");
  }
  const parts = [
    new TextEncoder().encode("ghostlink:policy:v3"),
    u64le(p.dailyCapUsdE6),
    u16le(p.maxSlippageBps),
    u64le(p.bigActionThresholdUsdE6),
    u64le(p.noOracleCapUsdE6),
    u64le(p.sessionMaxSlots),
    new Uint8Array([p.allowedOutMints.length]),
    ...p.allowedOutMints.map((m, i) => expect32(m, `allowedOutMints[${i}]`)),
    new Uint8Array([p.oracleFeeds.length]),
    ...p.oracleFeeds.flatMap((f, i) => {
      if (!Number.isInteger(f.decimals) || f.decimals < 0 || f.decimals > 255) throw new Error("decimals out of range");
      return [
        expect32(f.mint, `oracleFeeds[${i}].mint`),
        expect32(f.feedId, `oracleFeeds[${i}].feedId`),
        new Uint8Array([f.decimals]),
      ];
    }),
    new Uint8Array([s ? 1 : 0]),
    ...(s ? [u64le(s.dailyBuyCapUsdE6), u64le(s.maxCostExposureUsdE6),
      new Uint8Array([s.maxPositions, s.baseMints.length]),
      ...s.baseMints.map((mint, i) => expect32(mint, `speculative.baseMints[${i}]`))] : []),
  ];
  const total = parts.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

export function policyHash(p: Policy): Uint8Array {
  return sha256(policyBytes(p));
}

/** The conservative default policy (build plan, "Open decisions"). */
export function conservativePolicy(): Policy {
  return {
    dailyCapUsdE6: 200_000_000n, // 200 USD
    maxSlippageBps: 100, // 1%
    bigActionThresholdUsdE6: 50_000_000n, // 50 USD
    noOracleCapUsdE6: 20_000_000n, // 20 USD
    allowedOutMints: [],
    sessionMaxSlots: 216_000n, // ~24h at 2.5 slots/s
    oracleFeeds: [],
  };
}

export { u64le, u16le };
