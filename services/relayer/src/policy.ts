/** PolicyDto (JSON wire shape) -> the byte-level policy the kit encodes. */
import bs58 from "bs58";
import { hexToBytes, type Policy, type PolicyDto } from "@ghostlink/common";
import { badRequest, BorshWriter, writePolicy } from "@ghostlink/service-kit";

export function policyFromDtoBytes(d: PolicyDto): Policy {
  try {
    if (!d || !Array.isArray(d.allowedOutMints) || d.allowedOutMints.length > 8 ||
      !Array.isArray(d.oracleFeeds) || d.oracleFeeds.length > 8 ||
      !Number.isInteger(d.maxSlippageBps) || d.maxSlippageBps < 0 || d.maxSlippageBps > 10_000) {
      throw new Error("invalid policy limits");
    }
    for (const value of [d.dailyCapUsdE6, d.bigActionThresholdUsdE6, d.noOracleCapUsdE6, d.sessionMaxSlots]) {
      if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("invalid policy amount");
    }
    const policy = {
      dailyCapUsdE6: BigInt(d.dailyCapUsdE6),
      maxSlippageBps: d.maxSlippageBps,
      bigActionThresholdUsdE6: BigInt(d.bigActionThresholdUsdE6),
      noOracleCapUsdE6: BigInt(d.noOracleCapUsdE6),
      sessionMaxSlots: BigInt(d.sessionMaxSlots),
      allowedOutMints: d.allowedOutMints.map((m) => bs58.decode(m)),
      oracleFeeds: d.oracleFeeds.map((f) => ({
        mint: bs58.decode(f.mint),
        feedId: hexToBytes(f.feedIdHex),
        decimals: f.decimals,
      })),
    };
    // Check fixed byte lengths and integer ranges before building a paid transaction.
    writePolicy(new BorshWriter(), policy);
    return policy;
  } catch {
    throw badRequest("invalid policy: check amounts, keys, feeds and vector limits");
  }
}
