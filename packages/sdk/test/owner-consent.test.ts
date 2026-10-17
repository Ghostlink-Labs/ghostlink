import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import {
  appId, domainHash, hexToBytes, pocketPda, toBase58, CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID,
  type BotConsentStatus,
} from "@ghostlink/common";
import {
  ApplicationRegistry, applicationRegistryDigest, OwnerConsentController, GhostLink, policyToDto,
  softwareSession, type ApplicationManifest,
} from "../src/index.js";
import { verifyLogin } from "../../verify/src/index.js";
import { fixturePolicy } from "./fixture-policy.js";

// Published development proof and identity, not user data or a production ceremony.
const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("../../../circuits/keys/login_proof.json", import.meta.url), "utf8"));
const origin = "https://owner.example.com";
function setup() {
  const fx = vectors.circuits.login;
  const identity = { secret: hexToBytes(vectors.identity.sBytes), sField: BigInt(vectors.identity.sField),
    commitment: BigInt(vectors.identity.commitment), deterministic: true, method: "signMessage" as const, withFactor: false };
  const home = hexToBytes(vectors.identity.homeAddress), expirySlot = BigInt(vectors.identity.expirySlot);
  const policy = JSON.parse(JSON.stringify(policyToDto(fixturePolicy())));
  let now = 1_700_000_000, slot = Number(expirySlot - 100n);
  const deployment = { cluster: "localnet" as const, genesisHash: bs58.encode(new Uint8Array(32).fill(9)),
    pocketProgram: POCKET_PROGRAM_ID, registryProgram: REGISTRY_PROGRAM_ID, censusProgram: CENSUS_PROGRAM_ID };
  const manifest: ApplicationManifest = { version: 1, revision: 1, ownerOrigin: origin, deployment,
    issuedAt: now, expiresAt: now + 3600, applications: [
      { id: "first-bot", name: "First Bot", appOrigin: vectors.identity.origin, authorizationBaseUrl: "https://first.example.com/authorize/",
        telegramBotId: "123456", status: "enabled", policy },
      { id: "second-bot", name: "Second Bot", appOrigin: "https://second.example.com", authorizationBaseUrl: "https://second.example.com/",
        telegramBotId: "234567", status: "enabled", policy },
    ] };
  const registry = new ApplicationRegistry(manifest, applicationRegistryDigest(manifest));
  const readChainContext = vi.fn(async (_floor: number) => ({ genesisHash: deployment.genesisHash, slot }));
  const controller = new OwnerConsentController({ registry, readChainContext, nowSeconds: () => now, nodeOwnerOrigin: origin });
  const id = appId(identity.sField, domainHash(vectors.identity.origin)).toString();
  const status: BotConsentStatus = { state: "pending", consent: { version: 1, id: "ab".repeat(32), botId: "123456", userId: "789",
    appOrigin: vectors.identity.origin, deployment: structuredClone(deployment), appId: id, pocket: toBase58(pocketPda(BigInt(id)).address),
    home: toBase58(home), policy: structuredClone(policy), sessionKeyHex: Buffer.from(softwareSession(hexToBytes(vectors.identity.sessionSeed)).key32).toString("hex"),
    sessionExpirySlot: expirySlot.toString(), createdAt: now, expiresAt: now + 300 } };
  const expected = { applicationId: "first-bot", telegramUserId: "789", identity, home, expirySlot };
  const witness = {
    registry: { walletPubkey: hexToBytes(vectors.identity.walletPubkey), index: Number(fx.private.reg_index), siblings: fx.private.reg_siblings.map(BigInt), root: BigInt(fx.public.registry_root) },
    census: { index: Number(fx.private.cen_index), siblings: fx.private.cen_siblings.map(BigInt), root: BigInt(fx.public.census_root), amount: BigInt(vectors.census.amount), slot: BigInt(vectors.census.slot) },
  };
  const prover = { prove: vi.fn(async () => structuredClone(fixture)) };
  const params = { identity, witness, prover, minSlot: BigInt(fx.public.min_slot),
    claim: { kind: "holdsAtLeast" as const, mint: hexToBytes(vectors.census.mint), amount: BigInt(fx.public.threshold), maxAgeSlots: 9000n } };
  return { manifest, registry, controller, readChainContext, expected, status, params,
    setNow: (n: number) => { now = n; }, setSlot: (n: number) => { slot = n; } };
}
afterEach(() => vi.unstubAllGlobals());

describe("trusted owner consent", () => {
  it("produces the real verified circuit statement without changing ordinary page scoping", async () => {
    const f = setup();
    const browser: any = { location: { origin } }; browser.top = browser;
    vi.stubGlobal("window", browser);
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.example.com", origin: vectors.identity.origin });
    expect(client.origin()).toBe(origin);
    const review = await f.controller.review(f.status, f.expected);
    expect(Object.isFrozen(review.consent.policy.oracleFeeds)).toBe(true);
    f.status.consent.home = bs58.encode(new Uint8Array(32).fill(77)); // Wire response is snapshotted.
    const authorization = await f.controller.prove(review, f.params);
    expect(f.params.prover.prove.mock.calls[0]?.[1]).toEqual({ ...vectors.circuits.login.public, ...vectors.circuits.login.private });
    expect(authorization.signer).not.toHaveProperty("sign");
    expect(JSON.stringify(review)).not.toContain(vectors.identity.sBytes);
    expect((await verifyLogin({ proof: authorization.proof.snarkjsProof, publicSignals: authorization.proof.publicSignals,
      expectedDomain: vectors.identity.origin,
      roots: async () => ({ registry: [fixture.publicSignals[0]], census: [fixture.publicSignals[1]] }),
      expect: { pocket: { policy: fixturePolicy(), sessionKind: 0 }, session: { key32: authorization.signer.key32,
        expirySlot: f.expected.expirySlot, currentSlot: f.expected.expirySlot - 1n } },
    })).ok).toBe(true);
    await expect(f.controller.prove(review, f.params)).rejects.toThrow(/no longer/);
  });

  it("refuses cross-bot consent, substituted permissions and request values before proving", async () => {
    const mutations = [
      (s: any) => { s.consent.botId = "234567"; }, (s: any) => { s.consent.userId = "999"; },
      (s: any) => { s.consent.appOrigin = "https://second.example.com"; }, (s: any) => { s.consent.appId = "2"; },
      (s: any) => { s.consent.home = bs58.encode(new Uint8Array(32).fill(3)); },
      (s: any) => { s.consent.pocket = bs58.encode(new Uint8Array(32).fill(3)); },
      (s: any) => { s.consent.policy.dailyCapUsdE6 = "999999999"; }, (s: any) => { s.consent.policy.sessionMaxSlots = "0216000"; },
      (s: any) => { s.consent.deployment.genesisHash = bs58.encode(new Uint8Array(32).fill(4)); },
      (s: any) => { s.consent.sessionKeyHex = "00".repeat(32); }, (s: any) => { s.consent.sessionExpirySlot = "1"; },
      (s: any) => { s.consent.expiresAt += 901; }, (s: any) => { s.consent.createdAt += 31; },
      (s: any) => { s.state = "confirmed"; }, (s: any) => { s.consent.extra = "hidden permission"; },
    ];
    for (const mutate of mutations) {
      const f = setup(); mutate(f.status);
      await expect(f.controller.review(f.status, f.expected)).rejects.toThrow();
      expect(f.params.prover.prove).not.toHaveBeenCalled();
    }
    const f = setup();
    await expect(f.controller.review(f.status, { ...f.expected, applicationId: "second-bot" })).rejects.toThrow(/match owner/);
    const second = structuredClone(f.status);
    second.consent.appOrigin = "https://second.example.com"; second.consent.botId = "234567";
    second.consent.appId = appId(f.expected.identity.sField, domainHash(second.consent.appOrigin)).toString();
    second.consent.pocket = toBase58(pocketPda(BigInt(second.consent.appId)).address);
    const review = await f.controller.review(second, { ...f.expected, applicationId: "second-bot" });
    expect(review.consent.pocket).not.toBe(f.status.consent.pocket);
  });

  it("requires a current chain on the pinned deployment and never lowers an observed slot", async () => {
    const f = setup();
    const review = await f.controller.review(f.status, f.expected);
    f.setSlot(Number(f.expected.expirySlot - 101n));
    await expect(f.controller.prove(review, f.params)).rejects.toThrow(/regressed/);
    expect(f.params.prover.prove).not.toHaveBeenCalled();
    f.readChainContext.mockResolvedValue({ genesisHash: bs58.encode(new Uint8Array(32).fill(4)), slot: Number(f.expected.expirySlot - 1n) });
    await expect(f.controller.review(f.status, f.expected)).rejects.toThrow(/genesis/);
  });

  it("refuses forged review objects, untrusted origins and frames", async () => {
    const f = setup(), review = await f.controller.review(f.status, f.expected);
    await expect(f.controller.prove(structuredClone(review), f.params)).rejects.toThrow(/different owner/);
    for (const browser of [{ location: { origin: "https://partner.example.com" } }, { location: { origin }, top: {} }]) {
      vi.stubGlobal("window", browser);
      await expect(f.controller.prove(review, f.params)).rejects.toThrow(/top-level/);
    }
    expect(f.params.prover.prove).not.toHaveBeenCalled();
  });

  it("rejects cancellation, revocation, expiration and changed prover outputs before releasing a proof", async () => {
    for (const event of ["cancel", "registry", "request-expiry", "session-expiry", "signals"] as const) {
      const f = setup(), review = await f.controller.review(f.status, f.expected);
      f.params.prover.prove.mockImplementation(async () => {
        const result = structuredClone(fixture);
        if (event === "cancel") f.controller.cancel(review);
        if (event === "registry") {
          const next = { ...f.manifest, revision: 2, previousDigest: f.registry.digest };
          next.applications[0]!.status = "disabled";
          f.registry.update(next, applicationRegistryDigest(next));
        }
        if (event === "request-expiry") f.setNow(f.status.consent.expiresAt);
        if (event === "session-expiry") f.setSlot(Number(f.expected.expirySlot));
        if (event === "signals") result.publicSignals[11] = "0";
        return result;
      });
      await expect(f.controller.prove(review, f.params)).rejects.toThrow();
      await expect(f.controller.prove(review, f.params)).rejects.toThrow();
      expect(f.params.prover.prove).toHaveBeenCalledOnce();
    }
  });
});

describe("pinned application registry", () => {
  it("refuses unapproved manifests, public chains and shared namespaces", () => {
    const f = setup();
    expect(() => new ApplicationRegistry(f.manifest, "00".repeat(32))).toThrow(/unapproved/);
    for (const mutate of [
      (m: any) => { m.applications[1].appOrigin = m.applications[0].appOrigin; m.applications[0].status = "disabled"; },
      (m: any) => { m.applications[1].telegramBotId = m.applications[0].telegramBotId; },
      (m: any) => { m.applications[0].authorizationBaseUrl = origin + "/"; },
      (m: any) => { m.applications[0].appOrigin += "/"; },
      (m: any) => { m.deployment.genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; },
      (m: any) => { m.deployment.genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"; },
    ]) {
      const m = structuredClone(f.manifest); mutate(m);
      expect(() => applicationRegistryDigest(m)).toThrow();
    }
    expect(() => f.registry.snapshot(f.manifest.expiresAt)).toThrow(/not current/);
  });

  it("preserves namespace tombstones and rejects skipped, regressed and reassigned revisions", () => {
    const f = setup();
    for (const mutate of [
      (m: ApplicationManifest) => { m.revision = 3; }, (m: ApplicationManifest) => { m.previousDigest = "00".repeat(32); },
      (m: ApplicationManifest) => { m.applications.shift(); },
      (m: ApplicationManifest) => { m.applications[0]!.appOrigin = "https://replacement.example.com"; },
      (m: ApplicationManifest) => { m.applications[0]!.telegramBotId = "999"; },
    ]) {
      const m = { ...structuredClone(f.manifest), revision: 2, previousDigest: f.registry.digest }; mutate(m);
      expect(() => f.registry.update(m, applicationRegistryDigest(m))).toThrow();
    }
    const next = { ...structuredClone(f.manifest), revision: 2, previousDigest: f.registry.digest };
    next.applications[0]!.status = "disabled";
    f.registry.update(next, applicationRegistryDigest(next));
    expect(() => f.registry.application("first-bot", f.manifest.issuedAt)).toThrow(/not enabled/);
    const revived = { ...structuredClone(next), revision: 3, previousDigest: f.registry.digest };
    revived.applications[0]!.status = "enabled";
    expect(() => f.registry.update(revived, applicationRegistryDigest(revived))).toThrow(/revived/);
    next.applications[0]!.status = "enabled";
    expect(() => f.registry.application("first-bot", f.manifest.issuedAt)).toThrow(/not enabled/);
  });
});
