/** The relayer's spend meter: a rolling daily ceiling. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendMeter } from "../src/budget.js";

describe("spend meter", () => {
  it("stops paying once the rolling window is spent, and recovers as it rolls", () => {
    const meter = new SpendMeter(100n, 1000);
    expect(meter.tryCharge(60n, 0)).toBe(true);
    expect(meter.tryCharge(50n, 1)).toBe(false);
    expect(meter.tryCharge(40n, 2)).toBe(true);
    expect(meter.spentInWindow(3)).toBe(100n);
    expect(meter.tryCharge(1n, 999)).toBe(false);
    expect(meter.tryCharge(1n, 1000)).toBe(true);
  });

  it("cannot create negative credit that outlives a charge", () => {
    const meter = new SpendMeter(100n, 1000);
    expect(meter.tryCharge(100n, 0)).toBe(true);
    expect(() => meter.tryCharge(-100n, 1)).toThrow(/negative/);
    expect(meter.tryCharge(100n, 2)).toBe(false);
    expect(meter.spentInWindow(1000)).toBe(0n);
  });

  it("retains the ceiling across restarts and refuses corrupt persisted credit", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-budget-"));
    const path = join(dir, "budget.json");
    try {
      expect(new SpendMeter(100n, 1000, path).tryCharge(70n, 10)).toBe(true);
      const restored = new SpendMeter(100n, 1000, path);
      expect(restored.tryCharge(31n, 20)).toBe(false);
      expect(restored.tryCharge(30n, 20)).toBe(true);
      expect(new SpendMeter(100n, 1000, path).spentInWindow(1010)).toBe(30n);
      writeFileSync(path, JSON.stringify([{ at: 20, lamports: "-100" }]));
      expect(() => new SpendMeter(100n, 1000, path)).toThrow(/invalid/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
