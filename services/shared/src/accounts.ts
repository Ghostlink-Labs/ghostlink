import { sha256 } from "@noble/hashes/sha256";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import type { Policy } from "@ghostlink/common";
import { POCKET } from "./instructions.js";

const POCKET_DISC = sha256(new TextEncoder().encode("account:PocketV3")).subarray(0, 8);
/** Discriminator plus current Pocket::INIT_SPACE, including the bounded speculative ledger. */
export const POCKET_ACCOUNT_SIZE = 3293;

/** Same circular 2048-bit window as programs/pocket/src/state.rs. */
export function isPocketNonceUsed(account: { nonceBase: bigint; nonceBitmap: Uint8Array }, nonce: bigint): boolean {
  if (nonce < 0n || nonce > (1n << 64n) - 1n || account.nonceBitmap.length !== 256) throw new Error("invalid nonce window");
  if (nonce < account.nonceBase) return true;
  if (nonce - account.nonceBase >= 2048n) return false;
  const bit = Number(nonce % 2048n);
  return ((account.nonceBitmap[Math.floor(bit / 8)]! >> (bit % 8)) & 1) === 1;
}

/** A lamport transfer can create a system-owned PDA before its pocket is opened. */
export function isPocketAccount(info: AccountInfo<Uint8Array> | null, appId: Uint8Array, expectedProgram = POCKET): boolean {
  return Boolean(
    info && !info.executable && info.owner.equals(expectedProgram) && info.data.length >= 40 &&
    appId.length === 32 && POCKET_DISC.every((b, i) => info.data[i] === b) &&
    appId.every((b, i) => info.data[8 + i] === b),
  );
}

/** Decode the Borsh fields, whose offsets depend on policy and pending vectors. */
export function readPocketAccount(info: AccountInfo<Uint8Array>, expectedProgram = POCKET) {
  if (!isPocketAccount(info, info.data.subarray(8, 40), expectedProgram)) throw new Error("not a Pocket account");
  if (info.data.length !== POCKET_ACCOUNT_SIZE) {
    throw new Error(`unsupported Pocket account size: expected ${POCKET_ACCOUNT_SIZE}, got ${info.data.length}`);
  }
  let off = 8;
  const take = (size: number) => {
    if (off + size > info.data.length) throw new Error("truncated Pocket account");
    const bytes = info.data.subarray(off, off + size);
    off += size;
    return bytes;
  };
  const integer = (size: number) => {
    const bytes = take(size);
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) value = value * 256n + BigInt(bytes[i]!);
    return value;
  };
  const u8 = () => Number(integer(1));
  const u64 = () => integer(8);
  const key = () => new PublicKey(take(32));
  const vector = <T>(read: () => T): T[] => {
    const size = Number(integer(4));
    if (size > 8) throw new Error("invalid Pocket policy vector");
    return Array.from({ length: size }, read);
  };
  const readPolicy = (): Policy => {
    const policy: Policy = {
    dailyCapUsdE6: u64(), maxSlippageBps: Number(integer(2)),
    bigActionThresholdUsdE6: u64(), noOracleCapUsdE6: u64(), sessionMaxSlots: u64(),
    allowedOutMints: vector(() => take(32)),
    oracleFeeds: vector(() => ({ mint: take(32), feedId: take(32), decimals: u8() })),
    };
    const enabled = u8();
    if (enabled === 1) {
      policy.speculative = { dailyBuyCapUsdE6: u64(), maxCostExposureUsdE6: u64(),
        maxPositions: u8(), baseMints: vector(() => take(32)) };
    } else if (enabled !== 0) throw new Error("invalid speculative policy flag");
    return policy;
  };
  const appId = take(32);
  const domainHash = take(32);
  const home = key();
  const sessionKind = u8();
  const sessionKey = take(33);
  const sessionExpirySlot = u64();
  const policy = readPolicy();
  const hasPending = u8();
  let pending: { change: { home: PublicKey } | { policy: Policy }; executableAfterSlot: bigint } | undefined;
  if (hasPending === 1) {
    const tag = u8();
    if (tag !== 0 && tag !== 1) throw new Error("invalid Pocket change variant");
    pending = { change: tag === 0 ? { home: key() } : { policy: readPolicy() }, executableAfterSlot: u64() };
  } else if (hasPending !== 0) throw new Error("invalid Pocket pending flag");
  const dayStartSlot = u64();
  const spentTodayUsdE6 = u64();
  const nonceBitmap = take(256);
  const bump = u8();
  const maxSessionExpirySlot = u64();
  const nonceBase = u64();
  const ownerActionNonce = u64();
  const speculativeBoughtTodayUsdE6 = u64();
  const speculativePositions = Array.from({ length: 8 }, () => ({ mint: key(), baseMint: key(),
    tokenAccount: key(), quantity: u64(), costUsdE6: u64() })).filter(p => p.quantity > 0n);
  return { speculativeBoughtTodayUsdE6, speculativePositions, appId, domainHash, home, sessionKind, sessionKey, sessionExpirySlot, policy, pending,
    dayStartSlot, spentTodayUsdE6, nonceBitmap, bump, maxSessionExpirySlot, nonceBase, ownerActionNonce };
}
