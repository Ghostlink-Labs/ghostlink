/**
 * What the relayer is willing to pay, and for whom.
 *
 * The programs make sure a relayer can never be tricked into signing
 * something harmful; what they cannot stop is a registered identity
 * asking the relayer to fund an unbounded number of successful, useless
 * transactions — one pocket per invented origin, each costing rent. So
 * every paid request is metered against a rolling daily budget, and a
 * deployment may restrict pocket creation to the origins it partners
 * with (domain_hash is a public input, so the relayer can check it).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TX_FEE_LAMPORTS = 5_000n;
/** Rent-exempt minimum of a Pocket account (8 + 2081 bytes). */
export const POCKET_RENT_LAMPORTS = 15_430_320n;
/** Rent-exempt minimum of a registry Binding account (8 + 48 bytes). */
export const BINDING_RENT_LAMPORTS = 1_280_640n;
/** Rent-exempt minimum of an SPL token account. */
export const ATA_RENT_LAMPORTS = 2_039_280n;

export class SpendMeter {
  private charges: { at: number; lamports: bigint }[] = [];

  constructor(
    readonly dailyBudgetLamports: bigint,
    private readonly windowMs = 24 * 60 * 60 * 1000,
    private readonly persistPath?: string,
  ) {
    if (dailyBudgetLamports < 0n || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError("budget and window must be nonnegative and positive respectively");
    }
    if (persistPath && existsSync(persistPath)) {
      const snapshot = JSON.parse(readFileSync(persistPath, "utf8"));
      if (!Array.isArray(snapshot)) throw new Error("invalid spend-meter snapshot");
      this.charges = snapshot.map((charge) => {
        if (!charge || !Number.isSafeInteger(charge.at) || charge.at < 0 ||
          typeof charge.lamports !== "string" || !/^(0|[1-9][0-9]*)$/.test(charge.lamports)) {
          throw new Error("invalid spend-meter charge");
        }
        return { at: charge.at, lamports: BigInt(charge.lamports) };
      });
    }
  }

  spentInWindow(now = Date.now()): bigint {
    this.charges = this.charges.filter((c) => now - c.at < this.windowMs);
    return this.charges.reduce((sum, c) => sum + c.lamports, 0n);
  }

  /** Reserves `lamports` if the budget allows it; false means refuse. */
  tryCharge(lamports: bigint, now = Date.now()): boolean {
    if (lamports < 0n) throw new RangeError("charge must not be negative");
    if (this.spentInWindow(now) + lamports > this.dailyBudgetLamports) return false;
    this.charges.push({ at: now, lamports });
    // Persist before the caller broadcasts. If the write fails, fail closed.
    if (this.persistPath) {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.charges.map((c) => ({ at: c.at, lamports: c.lamports.toString() }))));
      renameSync(tmp, this.persistPath);
    }
    return true;
  }
}
