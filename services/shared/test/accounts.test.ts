import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { SystemProgram } from "@solana/web3.js";
import { BorshWriter, POCKET, POCKET_ACCOUNT_SIZE, isPocketAccount, isPocketNonceUsed, readPocketAccount, writePolicy } from "../src/index.js";
import type { Policy } from "@ghostlink/common";

const appId = new Uint8Array(32).fill(3);
const policy: Policy = { dailyCapUsdE6: 1n, maxSlippageBps: 100, bigActionThresholdUsdE6: 2n, noOracleCapUsdE6: 0n,
  sessionMaxSlots: 10n, allowedOutMints: [new Uint8Array(32).fill(5)],
  oracleFeeds: [{ mint: new Uint8Array(32).fill(5), feedId: new Uint8Array(32).fill(6), decimals: 9 }] };

describe("Pocket account decoding", () => {
  it("interprets wrapped nonce bits and never reuses values below the on-chain window", () => {
    const a = { nonceBase: 3000n, nonceBitmap: new Uint8Array(256) };
    a.nonceBitmap[0] = 128; // circular bit 7 belongs to 4103 in this window.
    expect(isPocketNonceUsed(a, 7n)).toBe(true);
    expect(isPocketNonceUsed(a, 2999n)).toBe(true);
    expect(isPocketNonceUsed(a, 3000n)).toBe(false);
    expect(isPocketNonceUsed(a, 4103n)).toBe(true);
    expect(isPocketNonceUsed(a, 6151n)).toBe(false); // same bit, beyond this window.
    expect(() => isPocketNonceUsed(a, 1n << 64n)).toThrow();
  });
  it("finds the owner nonce after dynamic policy and pending-change layouts", () => {
    for (const enabled of [false, true]) for (const pending of [undefined, "home", "policy"]) {
      const chosen: Policy = enabled ? { ...policy, noOracleCapUsdE6: 1n,
        speculative: { dailyBuyCapUsdE6: 2n, maxCostExposureUsdE6: 3n, maxPositions: 1,
          baseMints: [policy.oracleFeeds[0]!.mint] } } : policy;
      const w = new BorshWriter().fixed(sha256(new TextEncoder().encode("account:PocketV3")).subarray(0, 8))
        .fixed(appId).fixed(new Uint8Array(32)).fixed(SystemProgram.programId.toBytes())
        .u8(0).fixed(new Uint8Array(33)).u64(100n);
      writePolicy(w, chosen);
      w.option(pending, (writer, value) => {
        if (value === "home") writer.u8(0).fixed(SystemProgram.programId.toBytes());
        else { writer.u8(1); writePolicy(writer, chosen); }
        writer.u64(500n);
      });
      w.u64(1n).u64(2n).fixed(new Uint8Array(256)).u8(254).u64(100n).u64(2048n).u64(17n);
      w.u64(9n).fixed(new Uint8Array(32).fill(7)).fixed(new Uint8Array(32).fill(5))
        .fixed(SystemProgram.programId.toBytes()).u64(12n).u64(13n);
      const data = new Uint8Array(POCKET_ACCOUNT_SIZE);
      data.set(w.out());
      const info = { owner: POCKET, data, executable: false, lamports: 1, rentEpoch: 0 };
      expect(readPocketAccount(info).ownerActionNonce).toBe(17n);
      expect(readPocketAccount(info).policy).toEqual(chosen);
      expect(readPocketAccount(info).speculativeBoughtTodayUsdE6).toBe(9n);
      expect(readPocketAccount(info).speculativePositions).toHaveLength(1);
      expect(readPocketAccount(info).speculativePositions[0]).toMatchObject({ quantity: 12n, costUsdE6: 13n });
      expect(isPocketAccount({ ...info, owner: SystemProgram.programId }, appId)).toBe(false);
      // Old allocations had padding that looks like a zero owner nonce.
      expect(() => readPocketAccount({ ...info, data: info.data.subarray(0, 2081) })).toThrow(/unsupported Pocket account size/);
    }
  });
});
