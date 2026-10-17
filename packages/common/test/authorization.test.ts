import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { conservativePolicy, developmentSessionDeployment, hexToBytes, pocketAuthorizationContext } from "../src/index.js";

const v = JSON.parse(readFileSync(new URL("../fixtures/vectors.json", import.meta.url), "utf8"));
const policy = () => ({ ...conservativePolicy(), oracleFeeds: v.policyWithFeeds.feeds.map(
  (f: { mint: string; feedId: string; decimals: number }) => ({ mint: hexToBytes(f.mint), feedId: hexToBytes(f.feedId), decimals: f.decimals }),
) });

describe("V2 pocket authorization context", () => {
  it("pins the cross-language fixture and separates every deployment identity and key kind", () => {
    const expected = BigInt(v.circuits.login.public.authorization_context);
    expect(pocketAuthorizationContext(policy(), 0)).toBe(expected);
    expect(expected).not.toBe(0n);
    expect(pocketAuthorizationContext(policy(), 1)).not.toBe(expected);
    for (const key of ["pocketProgram", "registryProgram", "censusProgram"] as const) {
      const d = developmentSessionDeployment();
      d[key][0] ^= 1;
      expect(pocketAuthorizationContext(policy(), 0, d)).not.toBe(expected);
    }
    // Mutable caller state must not poison the default deployment.
    expect(pocketAuthorizationContext(policy(), 0)).toBe(expected);
    expect(() => pocketAuthorizationContext(policy(), 2)).toThrow(/session kind/);
    expect(() => pocketAuthorizationContext(policy(), 0, {
      ...developmentSessionDeployment(), pocketProgram: new Uint8Array(31),
    })).toThrow(/32 bytes/);
  });
});
