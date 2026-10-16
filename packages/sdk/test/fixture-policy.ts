import { conservativePolicy, hexToBytes } from "@ghostlink/common";
import { readFileSync } from "node:fs";

const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));

export function fixturePolicy() {
  return { ...conservativePolicy(), oracleFeeds: vectors.policyWithFeeds.feeds.map(
    (f: { mint: string; feedId: string; decimals: number }) => ({
      mint: hexToBytes(f.mint), feedId: hexToBytes(f.feedId), decimals: f.decimals,
    }),
  ) };
}
