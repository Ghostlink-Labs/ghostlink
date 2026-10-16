/** Intent validation against the shared fixtures. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { bytesToHex, hexToBytes, type IntentRequest } from "@ghostlink/common";
import { validateIntent } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vectors = JSON.parse(
  readFileSync(join(root, "packages/common/fixtures/vectors.json"), "utf8"),
);

function fixtureRequest(): IntentRequest {
  const f = vectors.intent.fields;
  const seed = hexToBytes(vectors.identity.sessionSeed);
  const hash = hexToBytes(vectors.intent.hash);
  const signature = ed25519.sign(hash, seed);
  return {
    pocket: bs58.encode(hexToBytes(f.pocket)),
    nonce: f.nonce,
    inMint: bs58.encode(hexToBytes(f.inMint)),
    inMax: f.inMax,
    outMint: bs58.encode(hexToBytes(f.outMint)),
    outMin: f.outMin,
    deadlineSlot: f.deadlineSlot,
    policyHashHex: f.policyHash,
    sessionKind: 0,
    signatureHex: bytesToHex(signature),
    sessionKeyHex: vectors.identity.sessionPubkey,
  };
}

describe("validateIntent", () => {
  it("accepts a correctly signed fixture intent", () => {
    const v = validateIntent(fixtureRequest());
    expect(bytesToHex(v.hash)).toBe(vectors.intent.hash);
    expect(v.intent.nonce.toString()).toBe(vectors.intent.fields.nonce);
  });

  it("rejects a signature by another key", () => {
    const req = fixtureRequest();
    const other = new Uint8Array(32).fill(5);
    req.signatureHex = bytesToHex(ed25519.sign(hexToBytes(vectors.intent.hash), other));
    expect(() => validateIntent(req)).toThrow(/does not verify/);
  });

  it("rejects tampered intent fields", () => {
    const req = fixtureRequest();
    req.outMin = "1";
    expect(() => validateIntent(req)).toThrow(/does not verify/);
  });

  it("refuses ambiguous numeric wire values and unknown session kinds", () => {
    for (const nonce of [7, "07", "7.0", "0x07", "-1", "1".repeat(100)]) {
      expect(() => validateIntent({ ...fixtureRequest(), nonce } as IntentRequest)).toThrow(/decimal string/);
    }
    expect(() => validateIntent({ ...fixtureRequest(), sessionKind: 2 } as unknown as IntentRequest)).toThrow(/sessionKind/);
  });
});
