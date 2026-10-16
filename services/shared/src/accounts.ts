import { sha256 } from "@noble/hashes/sha256";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import type { Policy } from "@ghostlink/common";
import { POCKET } from "./instructions.js";

const POCKET_DISC = sha256(new TextEncoder().encode("account:Pocket")).subarray(0, 8);
/** Discriminator plus current Pocket::INIT_SPACE, including owner_action_nonce. */
export const POCKET_ACCOUNT_SIZE = 2089;

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
  const readPolicy = (): Policy => ({
    dailyCapUsdE6: u64(), maxSlippageBps: Number(integer(2)),
    bigActionThresholdUsdE6: u64(), noOracleCapUsdE6: u64(), sessionMaxSlots: u64(),
    allowedOutMints: vector(() => take(32)),
    oracleFeeds: vector(() => ({ mint: take(32), feedId: take(32), decimals: u8() })),
  });
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
  return { appId, domainHash, home, sessionKind, sessionKey, sessionExpirySlot, policy, pending,
    dayStartSlot, spentTodayUsdE6, nonceBitmap, bump, maxSessionExpirySlot, nonceBase, ownerActionNonce };
}
