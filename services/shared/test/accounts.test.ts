import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { SystemProgram } from "@solana/web3.js";
import { BorshWriter, POCKET, POCKET_ACCOUNT_SIZE, isPocketAccount, readPocketAccount, writePolicy } from "../src/index.js";
import type { Policy } from "@ghostlink/common";

const appId = new Uint8Array(32).fill(3);
const policy: Policy = { dailyCapUsdE6: 1n, maxSlippageBps: 100, bigActionThresholdUsdE6: 2n, noOracleCapUsdE6: 0n,
  sessionMaxSlots: 10n, allowedOutMints: [new Uint8Array(32).fill(5)],
  oracleFeeds: [{ mint: new Uint8Array(32).fill(5), feedId: new Uint8Array(32).fill(6), decimals: 9 }] };

describe("Pocket account decoding", () => {
  it("finds the owner nonce after dynamic policy and pending-change layouts", () => {
    for (const pending of [undefined, "home", "policy"]) {
      const w = new BorshWriter().fixed(sha256(new TextEncoder().encode("account:Pocket")).subarray(0, 8))
        .fixed(appId).fixed(new Uint8Array(32)).fixed(SystemProgram.programId.toBytes())
        .u8(0).fixed(new Uint8Array(33)).u64(100n);
      writePolicy(w, policy);
      w.option(pending, (writer, value) => {
        if (value === "home") writer.u8(0).fixed(SystemProgram.programId.toBytes());
        else { writer.u8(1); writePolicy(writer, policy); }
        writer.u64(500n);
      });
      w.u64(1n).u64(2n).fixed(new Uint8Array(256)).u8(254).u64(100n).u64(2048n).u64(17n);
      const data = new Uint8Array(POCKET_ACCOUNT_SIZE);
      data.set(w.out());
      const info = { owner: POCKET, data, executable: false, lamports: 1, rentEpoch: 0 };
      expect(readPocketAccount(info).ownerActionNonce).toBe(17n);
      expect(readPocketAccount(info).policy).toEqual(policy);
      expect(isPocketAccount({ ...info, owner: SystemProgram.programId }, appId)).toBe(false);
      // Old allocations had padding that looks like a zero owner nonce.
      expect(() => readPocketAccount({ ...info, data: info.data.subarray(0, 2081) })).toThrow(/unsupported Pocket account size/);
    }
  });
});
