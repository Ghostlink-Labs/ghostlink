import { createHash } from "node:crypto";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { TOKEN } from "@ghostlink/service-kit";

export const RAYDIUM_CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
export const RAYDIUM_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], RAYDIUM_CP)[0];
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export type RouteChain = Pick<Connection, "getMultipleAccountsInfoAndContext">;
export interface ApprovedPool {
  pool: string;
  token0: string;
  token1: string;
  /** Combined trade and enabled creator fees, in millionths; protocol/fund shares are included in these fees. */
  maxTradeFeePpm: number;
}
export interface RaydiumPool {
  address: PublicKey; config: PublicKey; mint0: PublicKey; mint1: PublicKey;
  vault0: PublicKey; vault1: PublicKey; observation: PublicKey;
}
export class RouteRefused extends Error {
  constructor(message: string) { super(message); this.name = "RouteRefused"; }
}
export function requireRoute(ok: unknown, message: string): asserts ok {
  if (!ok) throw new RouteRefused(message);
}
export function checkSlot(slot: number, minimum: number, deadline: bigint): number {
  requireRoute(Number.isSafeInteger(slot) && slot >= minimum && BigInt(slot) <= deadline, "stale or expired route context");
  return slot;
}
export async function readRouteAccounts(chain: RouteChain, keys: PublicKey[], minimum: number, deadline: bigint) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    const response = await Promise.race([chain.getMultipleAccountsInfoAndContext(keys, { commitment: "confirmed", minContextSlot: minimum }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RouteRefused("route RPC unavailable")), 4_000); })]);
    checkSlot(response.context.slot, minimum, deadline);
    requireRoute(response.value.length === keys.length, "incomplete route account snapshot");
    return response;
  } catch (error) {
    if (error instanceof RouteRefused) throw error;
    // RPC URLs can contain credentials. Do not propagate transport errors into logs or responses.
    throw new RouteRefused("route RPC unavailable");
  } finally { clearTimeout(timer!); }
}
function discriminator(name: string) { return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8); }
function account(a: AccountInfo<Buffer> | null | undefined, owner: PublicKey, size: number, name?: string): Buffer {
  requireRoute(a && !a.executable && a.owner.equals(owner) && a.data.length === size, "unsupported route account layout or owner");
  if (name) requireRoute(a.data.subarray(0, 8).equals(discriminator(name)), "unsupported route account discriminator");
  return a.data;
}
function key(b: Buffer, offset: number) { return new PublicKey(b.subarray(offset, offset + 32)); }

/** Reviewed packed layout: raydium-cp-swap b3187ae, PoolState (637 bytes). */
export function readPool(a: AccountInfo<Buffer> | null | undefined, approval: ApprovedPool): RaydiumPool {
  const b = account(a, RAYDIUM_CP, 637, "PoolState");
  const p = { address: new PublicKey(approval.pool), config: key(b, 8), vault0: key(b, 72), vault1: key(b, 104),
    mint0: key(b, 168), mint1: key(b, 200), observation: key(b, 296) };
  requireRoute(p.mint0.toBase58() === approval.token0 && p.mint1.toBase58() === approval.token1 && !p.mint0.equals(p.mint1) &&
    key(b, 232).equals(TOKEN) && key(b, 264).equals(TOKEN), "pool mints or token programs differ from approval");
  requireRoute((b[329]! & 4) === 0 && b[390]! <= 1 && b[389]! <= 2, "pool swaps disabled or fee model unsupported");
  requireRoute(!p.vault0.equals(p.vault1), "pool vaults overlap");
  return p;
}
export function checkMint(a: AccountInfo<Buffer> | null | undefined): number {
  const b = account(a, TOKEN, 82);
  requireRoute(b[45] === 1 && b[44]! <= 18 && b.readUInt32LE(0) <= 1 && b.readUInt32LE(46) === 0,
    "mint uninitialized, freezable or unsupported");
  return b[44]!;
}
export function checkToken(a: AccountInfo<Buffer> | null | undefined, mint: PublicKey, owner: PublicKey) {
  const b = account(a, TOKEN, 165);
  requireRoute(key(b, 0).equals(mint) && key(b, 32).equals(owner) && b[108] === 1 &&
    b.readUInt32LE(72) === 0 && b.readUInt32LE(129) === 0 && b.readBigUInt64LE(121) === 0n &&
    b.readUInt32LE(109) === (mint.equals(NATIVE_MINT) ? 1 : 0), "token account authority, state or mint differs from route");
}
/** Recheck the pool with config/vaults in one RPC bank; never trust provider account names. */
export function checkPoolSnapshot(values: (AccountInfo<Buffer> | null)[], approval: ApprovedPool, expected: RaydiumPool) {
  const p = readPool(values[0], approval);
  for (const field of ["config", "vault0", "vault1", "mint0", "mint1", "observation"] as const)
    requireRoute(p[field].equals(expected[field]), "pool mapping changed during route preparation");
  const config = account(values[1], RAYDIUM_CP, 236, "AmmConfig");
  const pool = values[0]!.data;
  const fee = config.readBigUInt64LE(12) + (pool[390] === 1 ? config.readBigUInt64LE(108) : 0n);
  requireRoute(fee <= BigInt(approval.maxTradeFeePpm) && config.readBigUInt64LE(20) + config.readBigUInt64LE(28) <= 1_000_000n,
    "pool fees exceed operator approval");
  checkToken(values[2], p.mint0, RAYDIUM_AUTHORITY); checkToken(values[3], p.mint1, RAYDIUM_AUTHORITY);
  requireRoute(checkMint(values[4]) === pool[331] && checkMint(values[5]) === pool[332], "pool mint decimals differ");
  const observation = account(values[6], RAYDIUM_CP, 4075, "ObservationState");
  requireRoute(key(observation, 11).equals(p.address), "observation belongs to a different pool");
}
