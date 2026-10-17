import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import {
  commitment, hexToBytes, IncrementalTree, loginChallengeDigest, registryLeaf, secretToField, toBase58,
} from "@ghostlink/common";
import {
  buildLoginInput, createGhostLinkWallet, createPasskeyFactor, deriveIdentity, derivePocket, fundingOptions,
  GhostLink, normalizeDerToLowS, proveLogin, softwareSession, sweepDigest,
} from "../src/index.js";
import { verifyLogin } from "../../verify/src/index.js";

const fixture = JSON.parse(readFileSync(new URL("../../../circuits/keys/login_offchain_proof.json", import.meta.url), "utf8"));
const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));
afterEach(() => vi.unstubAllGlobals());

describe("browser transport", () => {
  it("calls the default browser fetch with its global receiver", async () => {
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ roots: [] }));
    });
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test" });
    await expect(client.roots("registry")).resolves.toEqual({ roots: [] });
  });
});

describe("identity boundaries", () => {
  it("refuses empty, wrong-account and wrong-message signatures instead of registering their hash", async () => {
    const seed = new Uint8Array(32).fill(7);
    const options = { cluster: "devnet" as const, domain: "ghostlink.test", address: toBase58(ed25519.getPublicKey(seed)) };
    for (const sign of [
      async () => new Uint8Array(),
      async (m: Uint8Array) => ed25519.sign(m, new Uint8Array(32).fill(8)),
      async () => ed25519.sign(new Uint8Array([1]), seed),
    ]) {
      await expect(deriveIdentity(sign, options)).rejects.toThrow(/invalid identity signature/);
    }
  });

  it("evaluates the newly created PRF credential rather than reopening discoverable selection", async () => {
    const id = new Uint8Array([7, 8, 9]);
    const first = new Uint8Array(32).fill(4);
    const get = vi.fn(async (options: CredentialRequestOptions) => {
      expect(new Uint8Array(options.publicKey!.allowCredentials![0]!.id as ArrayBuffer)).toEqual(id);
      return { getClientExtensionResults: () => ({ prf: { results: { first: first.buffer } } }) };
    });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", { credentials: {
      create: async () => ({ rawId: id.buffer, getClientExtensionResults: () => ({ prf: { enabled: true } }) }),
      get,
    } });
    expect(await createPasskeyFactor({ rpId: "ghostlink.test", userName: "user", userId: new Uint8Array([1]) })).toEqual(sha256(first));
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("proof and witness boundaries", () => {
  it("returns a verifiable proof and session-signed server challenge from the custom wallet feature", async () => {
    const signer = softwareSession(hexToBytes(vectors.identity.sessionSeed));
    const proof = await proveLogin({ prove: async () => fixture }, {}, BigInt(vectors.identity.appId));
    const wallet = createGhostLinkWallet({ login: async () => ({
      appId: proof.appId, appIdBase58: "", proof, signer, expirySlot: BigInt(vectors.identity.expirySlot),
    }) });
    const challenge = new Uint8Array(32).fill(19);
    const signed = await wallet.features["ghostlink:signIn"].signIn({ challenge });
    expect(ed25519.verify(signed.challengeSignature.signature, loginChallengeDigest(challenge), signed.session.key32)).toBe(true);
    expect(ed25519.verify(signed.challengeSignature.signature, loginChallengeDigest(new Uint8Array(32).fill(20)), signed.session.key32)).toBe(false);
    // The login feature must not be an oracle for arbitrary intent digests.
    expect(ed25519.verify(signed.challengeSignature.signature, challenge, signed.session.key32)).toBe(false);
    expect((await verifyLogin({
      proof: signed.proof, publicSignals: signed.publicSignals, expectedDomain: vectors.identity.origin,
      roots: async () => ({ registry: [fixture.publicSignals[0]], census: [fixture.publicSignals[1]] }),
      expect: { session: { ...signed.session, currentSlot: signed.session.expirySlot - 1n } },
    })).ok).toBe(true);
    await expect(wallet.features["ghostlink:signIn"].signIn({ challenge: new Uint8Array() })).rejects.toThrow(/server challenge/);
  });
  it("preserves a JSON proof that the backend actually verifies", async () => {
    const login = await proveLogin({ prove: async () => fixture }, {}, BigInt(vectors.identity.appId));
    const wire = JSON.parse(JSON.stringify({ proof: login.snarkjsProof, publicSignals: login.publicSignals }));
    const result = await verifyLogin({
      ...wire, expectedDomain: vectors.identity.origin,
      roots: async () => ({ registry: [fixture.publicSignals[0]], census: [fixture.publicSignals[1]] }),
    });
    expect(result).toEqual({ ok: true, appId: vectors.identity.appId });
    expect(login.proof.a).toHaveLength(64);
  });

  it("rejects a tampered witness before handing identity secrets to a prover", async () => {
    const secret = new Uint8Array(32).fill(2);
    const sField = secretToField(secret);
    const identity = { secret, sField, commitment: commitment(sField), deterministic: true, method: "signMessage" as const, withFactor: false };
    const walletPubkey = new Uint8Array(32).fill(3);
    const tree = new IncrementalTree();
    tree.append(registryLeaf(walletPubkey, identity.commitment));
    const params = {
      identity, origin: "https://app.test", session: softwareSession(), expirySlot: 10n,
      home: walletPubkey, witness: { registry: { walletPubkey, ...tree.path(0), root: tree.root } },
    };
    expect(() => buildLoginInput(params)).not.toThrow();
    params.witness.registry.siblings[0] = 1n;
    expect(() => buildLoginInput(params)).toThrow(/registry witness/);
  });

  it("bounds untrusted leaves pages and rejects truncated snapshots", async () => {
    for (const page of [
      { from: 0, nextIndex: -1, leaves: ["1"] },
      { from: 0, nextIndex: 1, leaves: ["1", "2"] },
      { from: 0, nextIndex: 2, leaves: [] },
      { from: 0, nextIndex: "2", leaves: ["1"] },
    ]) {
      const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", fetchFn: async () => Response.json(page) });
      await expect(client.localWitness("registry", 1n, 2)).rejects.toThrow(/leaves/);
    }
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", fetchFn: async () => Response.json({ from: 0, nextIndex: 2, leaves: ["1", "2"] }) });
    expect((await client.localWitness("registry", 1n, 2)).index).toBe(0);
  });
});

describe("funding and signatures", () => {
  it("refuses a substituted deposit address even when the app id is correct", () => {
    const pocket = derivePocket(123n, new Uint8Array(32));
    expect(fundingOptions(pocket, "https://actions.test/").address).toBe(toBase58(pocket.address));
    pocket.address = new Uint8Array(32).fill(9);
    expect(() => fundingOptions(pocket, "https://actions.test")).toThrow(/does not match/);
  });

  it("accepts valid raw P-256 signatures beginning with the DER tag", () => {
    const key = new Uint8Array(32).fill(9);
    for (let i = 0; i < 4096; i++) {
      const message = sha256(new TextEncoder().encode(String(i)));
      const raw = p256.sign(message, key).toCompactRawBytes();
      if (raw[0] !== 0x30) continue;
      expect(p256.verify(normalizeDerToLowS(raw), message, p256.getPublicKey(key))).toBe(true);
      return;
    }
    throw new Error("deterministic search did not find the regression case");
  });

  it("binds owner authorizations to their action nonce", () => {
    const pocket = hexToBytes(vectors.intent.fields.pocket);
    expect(sweepDigest(pocket, 0n)).not.toEqual(sweepDigest(pocket, 1n));
    expect(() => sweepDigest(pocket, -1n)).toThrow(/u64/);
  });
});
