/** Verifies the committed fixture proof through the public API. */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledLoginVerificationKey, verifyLogin } from "../src/index.js";
import { hexToBytes } from "@ghostlink/common";
import { ed25519 } from "@noble/curves/ed25519";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vkPath = join(root, "circuits/keys/login_vk.json");
const proofPath = join(root, "circuits/keys/login_proof.json");
const built = existsSync(vkPath) && existsSync(proofPath);

describe.skipIf(!built)("verifyLogin", () => {
  const fx = () => JSON.parse(readFileSync(proofPath, "utf8"));
  const vectors = JSON.parse(
    readFileSync(join(root, "packages/common/fixtures/vectors.json"), "utf8"),
  );
  const pub = vectors.circuits.login.public;
  const roots = async () => ({
    registry: [pub.registry_root],
    census: [pub.census_root],
  });
  const sessionKey32 = ed25519.getPublicKey(hexToBytes(vectors.identity.sessionSeed));
  const expirySlot = BigInt(vectors.identity.expirySlot);
  const base = () => {
    const f = fx();
    return {
      proof: f.proof as object,
      publicSignals: f.publicSignals as string[],
      expectedDomain: vectors.identity.origin as string,
      roots,
    };
  };

  it("ships the same verifying key the circuits produced", () => {
    expect(bundledLoginVerificationKey()).toEqual(JSON.parse(readFileSync(vkPath, "utf8")));
  });

  it("accepts the fixture proof for its domain, session and home", async () => {
    const res = await verifyLogin({
      ...base(),
      expect: {
        holdsAtLeast: { mintHi: pub.mint_hi, mintLo: pub.mint_lo, threshold: 100_000_000n },
        minSlot: BigInt(pub.min_slot),
        session: { key32: sessionKey32, expirySlot, currentSlot: expirySlot - 10n },
        home: hexToBytes(vectors.identity.homeAddress),
      },
    });
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.appId).toBe(vectors.identity.appId);
  });

  it("rejects the proof for another domain", async () => {
    const res = await verifyLogin({ ...base(), expectedDomain: "https://evil.example.com" });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("different domain");
  });

  it("rejects unknown roots and refuses to run without a root source", async () => {
    const unknown = await verifyLogin({
      ...base(),
      roots: async () => ({ registry: ["1"], census: ["2"] }),
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toContain("unknown registry root");

    const none = await verifyLogin({ ...base(), roots: undefined });
    expect(none.ok).toBe(false);
    expect(none.reason).toContain("no root source");
  });

  it("rejects a captured proof presented with another session key, and after expiry", async () => {
    const other = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    const wrongKey = await verifyLogin({
      ...base(),
      expect: { session: { key32: other, expirySlot, currentSlot: expirySlot - 10n } },
    });
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.reason).toContain("different session key");

    const expired = await verifyLogin({
      ...base(),
      expect: { session: { key32: sessionKey32, expirySlot, currentSlot: expirySlot } },
    });
    expect(expired.ok).toBe(false);
    expect(expired.reason).toContain("expired");
  });

  it("returns one canonical app id however the signal is spelled", async () => {
    const f = fx();
    const padded = [...f.publicSignals];
    padded[3] = "0" + padded[3];
    const res = await verifyLogin({ ...base(), publicSignals: padded });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("malformed");
    const hex = [...f.publicSignals];
    hex[3] = "0x" + BigInt(hex[3]!).toString(16);
    expect((await verifyLogin({ ...base(), publicSignals: hex })).ok).toBe(false);
  });

  it("treats minSlot without a holdings claim as an error, not a pass", async () => {
    const f = fx();
    const signals = [...f.publicSignals];
    signals[10] = "0"; // claim off (the proof no longer verifies either way)
    const res = await verifyLogin({ ...base(), publicSignals: signals, expect: { minSlot: 1n } });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("meaningless");
  });

  it("rejects a tampered proof and malformed input without throwing", async () => {
    const f = fx();
    const tampered = JSON.parse(JSON.stringify(f.proof));
    tampered.pi_a[0] = "1";
    expect((await verifyLogin({ ...base(), proof: tampered })).ok).toBe(false);
    expect((await verifyLogin({ ...base(), proof: { nonsense: true } })).ok).toBe(false);
    expect((await verifyLogin({ ...base(), publicSignals: ["1e3"] })).ok).toBe(false);
  });

  it("fails closed for malformed request shapes and field-sized slot aliases", async () => {
    for (const publicSignals of [undefined, null, {}, "not-an-array", ["9".repeat(100_000)]]) {
      await expect(verifyLogin({ ...base(), publicSignals: publicSignals as never })).resolves.toMatchObject({ ok: false });
    }
    await expect(verifyLogin(null as never)).resolves.toMatchObject({ ok: false });
    const invalidRequirement = await verifyLogin({
      ...base(), expect: { holdsAtLeast: { mintHi: pub.mint_hi, mintLo: pub.mint_lo, threshold: NaN as never } },
    });
    expect(invalidRequirement).toMatchObject({ ok: false, reason: "expected threshold must be a u64 bigint" });
    const fieldPrime = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    // Poseidon reduces its inputs. An expiry plus p has the same commitment,
    // but is not a real chain slot and must not revive an old session.
    const result = await verifyLogin({
      ...base(), expect: { session: { key32: sessionKey32, expirySlot: expirySlot + fieldPrime, currentSlot: expirySlot + fieldPrime - 1n } },
    });
    expect(result).toMatchObject({ ok: false, reason: "session slots must be u64 bigints" });
  });
});
