import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/p256";
import { hexToBytes } from "@ghostlink/common";
import { GhostLink, copySessionPublicKey, sessionPublicKey, softwareSession } from "../src/index.js";
import { verifyLogin } from "../../verify/src/index.js";
import { fixturePolicy } from "./fixture-policy.js";

// Published development vectors, never a user identity or bot key.
const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("../../../circuits/keys/login_proof.json", import.meta.url), "utf8"));

function authorizationParams() {
  const fx = vectors.circuits.login;
  return {
    identity: {
      secret: hexToBytes(vectors.identity.sBytes), sField: BigInt(vectors.identity.sField),
      commitment: BigInt(vectors.identity.commitment), deterministic: true, method: "signMessage" as const, withFactor: false,
    },
    session: sessionPublicKey(0, softwareSession(hexToBytes(vectors.identity.sessionSeed)).key32),
    claim: { kind: "holdsAtLeast" as const, mint: hexToBytes(vectors.census.mint), amount: BigInt(fx.public.threshold), maxAgeSlots: 9000n },
    minSlot: BigInt(fx.public.min_slot), expirySlot: BigInt(vectors.identity.expirySlot),
    home: hexToBytes(vectors.identity.homeAddress),
    policy: fixturePolicy(),
    witness: {
      registry: { walletPubkey: hexToBytes(vectors.identity.walletPubkey), index: Number(fx.private.reg_index), siblings: fx.private.reg_siblings.map(BigInt), root: BigInt(fx.public.registry_root) },
      census: { index: Number(fx.private.cen_index), siblings: fx.private.cen_siblings.map(BigInt), root: BigInt(fx.public.census_root), amount: BigInt(vectors.census.amount), slot: BigInt(vectors.census.slot) },
    },
  };
}

describe("public bot session authorization", () => {
  it("uses only a public bot key and produces the existing verifiable circuit contract", async () => {
    const params = authorizationParams();
    const expectedKey = params.session.key32.slice();
    const prover = { prove: vi.fn(async (_circuit, input) => {
      expect(input).toEqual({ ...vectors.circuits.login.public, ...vectors.circuits.login.private });
      // A caller changing its descriptor during proving must not substitute the authorized key.
      params.session.key32.fill(0);
      params.session.key33.fill(0);
      return fixture;
    }) };
    const fetchFn = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.sessionKeyHex).toBe(Buffer.concat([Buffer.from(expectedKey), Buffer.from([0])]).toString("hex"));
      expect(body).not.toHaveProperty("identity");
      expect(body).not.toHaveProperty("witness");
      expect(JSON.stringify(body)).not.toContain(vectors.identity.sBytes);
      return Response.json({ signature: "test-transport-only" });
    });
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", relayer: "https://relayer.test", origin: vectors.identity.origin, prover, fetchFn });
    const authorization = await client.authorizeSession(params);
    expect(authorization.signer.key32).toEqual(expectedKey);
    expect(authorization.signer).not.toHaveProperty("sign");
    const verify = (key32: Uint8Array) => verifyLogin({
      proof: authorization.proof.snarkjsProof, publicSignals: authorization.proof.publicSignals,
      expectedDomain: vectors.identity.origin,
      roots: async () => ({ registry: [fixture.publicSignals[0]], census: [fixture.publicSignals[1]] }),
      expect: { pocket: { policy: params.policy, sessionKind: 0 }, session: { key32, expirySlot: params.expirySlot, currentSlot: params.expirySlot - 1n } },
    });
    expect((await verify(expectedKey)).ok).toBe(true);
    expect((await verify(softwareSession().key32)).ok).toBe(false);
    await client.openSession(authorization, client.pocketFor(authorization, params.home, params.policy), {
      mint: params.claim.mint, threshold: params.claim.amount, minSlot: params.minSlot, claim: true,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    // A policy changed after proving cannot be sent to the relayer.
    const pocket = client.pocketFor(authorization, params.home, params.policy);
    pocket.policy.dailyCapUsdE6 += 1n;
    await expect(client.openSession(authorization, pocket, {
      mint: params.claim.mint, threshold: params.claim.amount, minSlot: params.minSlot, claim: true,
    })).rejects.toThrow(/approved V2 authorization/);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects malformed or substituted keys before proving", async () => {
    const prover = { prove: vi.fn() };
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin: vectors.identity.origin, prover });
    const params = authorizationParams();
    params.session.key32[0] ^= 1;
    await expect(client.authorizeSession(params)).rejects.toThrow(/do not match/);
    expect(prover.prove).not.toHaveBeenCalled();
    expect(() => sessionPublicKey(0, new Uint8Array(64))).toThrow(/32-byte/);
    expect(() => sessionPublicKey(0, new Uint8Array(32))).toThrow();
    const badPadding = authorizationParams().session;
    badPadding.key33[32] = 1;
    expect(() => copySessionPublicKey(badPadding)).toThrow(/descriptor/);
    const passkey = sessionPublicKey(1, p256.getPublicKey(new Uint8Array(32).fill(4), true));
    expect(copySessionPublicKey(passkey)).toEqual(passkey);
    await expect(client.authorizeSession({ ...authorizationParams(), session: passkey })).rejects.toThrow(/Ed25519/);
    expect(prover.prove).not.toHaveBeenCalled();
    expect(() => sessionPublicKey(1, new Uint8Array(33))).toThrow();
  });
});

it("refuses undeployed V2 networks before using old deployment IDs or contacting services", async () => {
  const fetchFn = vi.fn();
  await expect(GhostLink.init({ cluster: "mainnet-beta", indexer: "https://indexer.test", fetchFn })).rejects.toThrow(/no verified devnet or mainnet/);
  await expect(GhostLink.init({ cluster: "devnet", indexer: "https://indexer.test", fetchFn })).rejects.toThrow(/no verified devnet or mainnet/);
  expect(fetchFn).not.toHaveBeenCalled();
  await expect(GhostLink.init({ cluster: "localnet", indexer: "http://localhost:8787" })).resolves.toBeInstanceOf(GhostLink);
});
