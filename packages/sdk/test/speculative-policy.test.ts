import { expect, it } from "vitest";
import { conservativePolicy, policyHash, type Policy } from "@ghostlink/common";
import { policyToDto, policyFromDto } from "../src/ghostlink.js";

it("preserves explicit speculative consent in wire conversions and rejects unusable bases", () => {
  const mint = new Uint8Array(32).fill(1);
  const policy: Policy = { ...conservativePolicy(), oracleFeeds: [{ mint, feedId: new Uint8Array(32).fill(2), decimals: 9 }],
    speculative: { dailyBuyCapUsdE6: 30_000_000n, maxCostExposureUsdE6: 20_000_000n, maxPositions: 2, baseMints: [mint] } };
  expect(policyFromDto(policyToDto(policy))).toEqual(policy);
  const hash = policyHash(policy);
  expect(policyHash({ ...policy, speculative: undefined })).not.toEqual(hash);
  for (const field of ["dailyBuyCapUsdE6", "maxCostExposureUsdE6"] as const) {
    expect(policyHash({ ...policy, speculative: { ...policy.speculative!, [field]: policy.speculative![field] + 1n } })).not.toEqual(hash);
  }
  for (const baseMints of [[], [mint, mint], [new Uint8Array(32).fill(3)]]) {
    expect(() => policyHash({ ...policy, speculative: { ...policy.speculative!, baseMints } })).toThrow(/speculative/);
  }
  expect(() => policyHash({ ...policy, allowedOutMints: [new Uint8Array(32).fill(3)] })).toThrow(/speculative/);
  expect(() => policyHash({ ...policy, speculative: { ...policy.speculative!, maxPositions: 9 } })).toThrow(/speculative/);
});
