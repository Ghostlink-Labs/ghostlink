/** The solver must never deliver more than the input is worth. */
import { describe, expect, it } from "vitest";
import { checkEconomics, parsePriceUpdate, usdE6 } from "../src/economics.js";

// USDC at $1.00 and SOL at $156.25, both exponent -8 (the fixture feeds).
const usdc = { price: 100_000_000n, exponent: -8, decimals: 6 };
const sol = { price: 15_625_000_000n, exponent: -8, decimals: 9 };

describe("economics", () => {
  it("values amounts exactly like the pocket's usd_e6", () => {
    expect(usdE6(25_000_000n, usdc)).toBe(25_000_000n);
    expect(usdE6(160_000_000n, sol)).toBe(25_000_000n);
  });

  it("accepts a fair fill and refuses an overpaying one", () => {
    expect(checkEconomics({ inMax: 25_000_000n, outMin: 160_000_000n }, { in: usdc, out: sol }, 100).ok).toBe(true);
    // 1% spread allows up to 161.6M lamports for $25.
    expect(checkEconomics({ inMax: 25_000_000n, outMin: 161_600_000n }, { in: usdc, out: sol }, 100).ok).toBe(true);
    const greedy = checkEconomics({ inMax: 25_000_000n, outMin: 161_700_000n }, { in: usdc, out: sol }, 100);
    expect(greedy.ok).toBe(false);
    expect(greedy.reason).toContain("more than the input is worth");
  });

  it("refuses the inventory-drain shape: spend nothing, receive the solver's balance", () => {
    const drain = checkEconomics({ inMax: 0n, outMin: 1_000_000_000_000n }, { in: usdc, out: sol }, 100);
    expect(drain.ok).toBe(false);
    expect(drain.reason).toContain("spends nothing");
  });

  it("does not round a sub-micro-dollar overpayment into a free fill", () => {
    const tiny = { price: 1n, exponent: -8, decimals: 9 };
    expect(checkEconomics({ inMax: 1n, outMin: 1000n }, { in: tiny, out: tiny }, 100).ok).toBe(false);
    expect(checkEconomics({ inMax: 1000n, outMin: 1010n }, { in: tiny, out: tiny }, 100).ok).toBe(true);
    expect(() => usdE6(1n, { ...tiny, exponent: 2_147_483_647 })).toThrow(/arithmetic/);
  });

  it("refuses unpriced output mints unless the deployment opts in", () => {
    const nft = { inMax: 10_000_000n, outMin: 1n };
    expect(checkEconomics(nft, { in: usdc }, 100).ok).toBe(false);
    expect(checkEconomics(nft, { in: usdc }, 100, true).ok).toBe(true);
  });

  it("parses a PriceUpdateV2 account and rejects partial verification", () => {
    const build = (level: number) => {
      const data = Buffer.alloc(134);
      Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]).copy(data, 0);
      data[40] = level;
      data.writeBigInt64LE(15_625_000_000n, 73);
      data.writeInt32LE(-8, 89);
      return new Uint8Array(data);
    };
    expect(parsePriceUpdate(build(1))).toEqual({ price: 15_625_000_000n, exponent: -8 });
    expect(() => parsePriceUpdate(build(0))).toThrow(/fully verified/);
  });
});
