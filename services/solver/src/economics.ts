/**
 * The solver's side of the trade. The on-chain oracle floor protects the
 * USER (they receive at least `out_min`, worth at least the input minus
 * slippage); nothing on-chain stops a solver from delivering far MORE
 * than the input is worth. So before any inventory moves, the solver
 * values both legs with the same price accounts the pocket will use and
 * refuses intents that ask for more than the input plus its spread.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { SPL_TOKEN_PROGRAM_ID, type Intent } from "@ghostlink/common";

export interface PriceInfo {
  price: bigint;
  exponent: number;
  decimals: number;
}

const PRICE_UPDATE_V2_DISC = [34, 241, 35, 99, 157, 126, 244, 205];
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const TOKEN_PROGRAM = new PublicKey(SPL_TOKEN_PROGRAM_ID);

/** Parses a Pyth PriceUpdateV2 account the way programs/pocket/src/oracle.rs does. */
export function parsePriceUpdate(data: Uint8Array): { price: bigint; exponent: number } {
  if (data.length < 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8) throw new Error("price account too short");
  if (!PRICE_UPDATE_V2_DISC.every((b, i) => data[i] === b)) throw new Error("not a PriceUpdateV2 account");
  let off = 8 + 32;
  if (data[off] !== 1) throw new Error("price update is not fully verified");
  off += 1 + 32; // verification level, feed id
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const price = view.getBigInt64(off, true);
  off += 8 + 8; // price, conf
  const exponent = view.getInt32(off, true);
  if (price <= 0n) throw new Error("non-positive price");
  return { price, exponent };
}

/** USD value in micro-dollars, same arithmetic as the pocket's usd_e6. */
export function usdE6(amount: bigint, p: PriceInfo): bigint {
  const scale = 6 + p.exponent - p.decimals;
  if (amount < 0n || p.price <= 0n || !Number.isInteger(scale) || Math.abs(scale) > 38) {
    throw new Error("price scale or amount is outside supported arithmetic");
  }
  const base = amount * p.price;
  return scale >= 0 ? base * 10n ** BigInt(scale) : base / 10n ** BigInt(-scale);
}

export interface EconomicsCheck {
  ok: boolean;
  reason?: string;
  inUsdE6?: bigint;
  outUsdE6?: bigint;
}

/**
 * Accepts an intent only when what the solver must deliver is worth no
 * more than what it receives plus `maxSpreadBps`. Unpriced output mints
 * cannot be valued and are refused unless the deployment opts in.
 */
export function checkEconomics(
  intent: Pick<Intent, "inMax" | "outMin">,
  prices: { in: PriceInfo; out?: PriceInfo },
  maxSpreadBps: number,
  allowUnpriced = false,
): EconomicsCheck {
  if (!Number.isInteger(maxSpreadBps) || maxSpreadBps < 0 || maxSpreadBps > 10_000) {
    throw new Error("maximum spread must be an integer from 0 to 10000 bps");
  }
  if (intent.inMax <= 0n) return { ok: false, reason: "intent spends nothing" };
  const inUsdE6 = usdE6(intent.inMax, prices.in);
  if (!prices.out) {
    return allowUnpriced
      ? { ok: true, inUsdE6 }
      : { ok: false, reason: "output mint has no price; this solver only fills priced mints", inUsdE6 };
  }
  const outUsdE6 = usdE6(intent.outMin, prices.out);
  // Compare at a common scale without rounding either leg down to zero.
  const inScale = 6 + prices.in.exponent - prices.in.decimals;
  const outScale = 6 + prices.out.exponent - prices.out.decimals;
  const commonScale = Math.min(inScale, outScale);
  const inValue = intent.inMax * prices.in.price * 10n ** BigInt(inScale - commonScale);
  const outValue = intent.outMin * prices.out.price * 10n ** BigInt(outScale - commonScale);
  if (outValue * 10_000n > inValue * BigInt(10_000 + maxSpreadBps)) {
    return { ok: false, reason: "intent asks for more than the input is worth", inUsdE6, outUsdE6 };
  }
  return { ok: true, inUsdE6, outUsdE6 };
}

/** Fetches price accounts and mint decimals (cached) for the economics check. */
export class PriceReader {
  private decimals = new Map<string, number>();

  constructor(
    private readonly connection: Connection,
    private readonly priceAccounts: Record<string, string>,
  ) {}

  async priceFor(mint: PublicKey): Promise<PriceInfo | undefined> {
    const account = this.priceAccounts[mint.toBase58()];
    if (!account) return undefined;
    const [priceInfo, decimals] = await Promise.all([
      this.connection.getAccountInfo(new PublicKey(account), "confirmed"),
      this.decimalsOf(mint),
    ]);
    if (!priceInfo) throw new Error(`price account ${account} not found`);
    if (!priceInfo.owner.equals(PYTH_RECEIVER)) throw new Error("price account is not owned by the Pyth receiver");
    const { price, exponent } = parsePriceUpdate(new Uint8Array(priceInfo.data));
    return { price, exponent, decimals };
  }

  private async decimalsOf(mint: PublicKey): Promise<number> {
    const key = mint.toBase58();
    const hit = this.decimals.get(key);
    if (hit !== undefined) return hit;
    const info = await this.connection.getAccountInfo(mint, "confirmed");
    if (!info || !info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 82 || info.data[45] !== 1) {
      throw new Error(`mint ${key} is not an initialized SPL Token mint`);
    }
    const decimals = info.data[44]!; // SPL Mint layout: decimals at offset 44
    this.decimals.set(key, decimals);
    return decimals;
  }
}
