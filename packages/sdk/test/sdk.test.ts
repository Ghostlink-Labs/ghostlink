/**
 * SDK tests against the shared fixtures: identity derivation, login
 * input assembly (must reproduce the exact circuit fixture inputs),
 * intent signing, action digests, and — when circuits are built — a real
 * end-to-end prove+verify through snarkjs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { fixturePolicy } from "./fixture-policy.js";
import {
  bytesToHex,
  hexToBytes,
  intentBytes,
  intentHash,
  policyHash,
  conservativePolicy,
  type Policy,
} from "@ghostlink/common";
import {
  buildLoginInput,
  deriveIdentity,
  derivePocket,
  changeHomeBorsh,
  changeDigest,
  signIntent,
  softwareSession,
  sweepDigest,
  normalizeDerToLowS,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vectors = JSON.parse(
  readFileSync(join(root, "packages/common/fixtures/vectors.json"), "utf8"),
);
const label = (name: string) =>
  sha256(new TextEncoder().encode(`ghostlink vector: ${name}`));

async function fixtureIdentity() {
  // A deterministic "wallet": ed25519 over the fixture wallet seed. The
  // identity secret must come out as SHA-256 of the signature over the
  // fixed message — but the FIXTURE secret is the label bytes, so build
  // the DerivedIdentity directly from them instead.
  const sBytes = hexToBytes(vectors.identity.sBytes);
  const { secretToField, commitment } = await import("@ghostlink/common");
  const sField = secretToField(sBytes);
  return { secret: sBytes, sField, commitment: commitment(sField), deterministic: true };
}

describe("identity derivation", () => {
  const seed = label("wallet seed");
  const address = bs58.encode(ed25519.getPublicKey(seed));
  const opts = { cluster: "devnet" as const, domain: "app.ghostlink.test", address };

  it("derives a stable secret from a domain-bound sign-in message", async () => {
    const signed: Uint8Array[] = [];
    const sign = async (msg: Uint8Array) => {
      signed.push(msg);
      return ed25519.sign(msg, seed);
    };
    const id1 = await deriveIdentity(sign, opts);
    const id2 = await deriveIdentity(sign, opts);
    expect(id1.deterministic).toBe(true);
    expect(id1.method).toBe("signMessage");
    expect(bytesToHex(id1.secret)).toBe(bytesToHex(id2.secret));
    // The signed text is a Sign-In-With-Solana message: GhostLink's domain
    // first (wallets show and check it), the address, the warning, the chain.
    const text = new TextDecoder().decode(signed[0]!);
    expect(text.startsWith(`app.ghostlink.test wants you to sign in with your Solana account:\n${address}\n\n`)).toBe(true);
    expect(text).toContain("Never sign it");
    expect(text).toContain("\nChain ID: devnet");
    const mainnet = await deriveIdentity(sign, { ...opts, cluster: "mainnet-beta" });
    expect(bytesToHex(mainnet.secret)).not.toBe(bytesToHex(id1.secret));
    const elsewhere = await deriveIdentity(sign, { ...opts, domain: "evil.example" });
    expect(bytesToHex(elsewhere.secret)).not.toBe(bytesToHex(id1.secret));
  });

  it("gives the same secret through native sign-in and through signMessage", async () => {
    const { signInMessageText } = await import("../src/identity.js");
    const signMessage = async (msg: Uint8Array) => ed25519.sign(msg, seed);
    const plain = await deriveIdentity(signMessage, opts);
    const native = await deriveIdentity(
      {
        signMessage,
        signIn: async (input) => {
          const bytes = new TextEncoder().encode(signInMessageText(input));
          return { signedMessage: bytes, signature: ed25519.sign(bytes, seed) };
        },
      },
      opts,
    );
    expect(native.method).toBe("signIn");
    expect(bytesToHex(native.secret)).toBe(bytesToHex(plain.secret));

    // A wallet that injects a timestamp into the sign-in text is not
    // repeatable; the SDK falls back to signMessage over the fixed bytes.
    const volatile = await deriveIdentity(
      {
        signMessage,
        signIn: async (input) => {
          const bytes = new TextEncoder().encode(signInMessageText({ ...input, issuedAt: new Date().toISOString() }));
          return { signedMessage: bytes, signature: ed25519.sign(bytes, seed) };
        },
      },
      opts,
    );
    expect(volatile.method).toBe("signMessage");
    expect(bytesToHex(volatile.secret)).toBe(bytesToHex(plain.secret));
  });

  it("mixes in a device-held second factor", async () => {
    const sign = async (msg: Uint8Array) => ed25519.sign(msg, seed);
    const plain = await deriveIdentity(sign, opts);
    const withFactor = await deriveIdentity(sign, { ...opts, secondFactor: new Uint8Array(32).fill(5) });
    expect(withFactor.withFactor).toBe(true);
    expect(bytesToHex(withFactor.secret)).not.toBe(bytesToHex(plain.secret));
    const again = await deriveIdentity(sign, { ...opts, secondFactor: new Uint8Array(32).fill(5) });
    expect(bytesToHex(again.secret)).toBe(bytesToHex(withFactor.secret));
    await expect(deriveIdentity(sign, { ...opts, secondFactor: new Uint8Array(3) })).rejects.toThrow(/32 bytes/);
  });

  it("refuses hedged signers unless the caller accepts an unrecoverable secret", async () => {
    let i = 0;
    // Real Ed25519 signatures over the SAME message, with distinct nonces.
    // Signing different messages does not model a valid hedged wallet.
    const key = ed25519.utils.getExtendedPublicKey(seed);
    const le = (value: bigint) => {
      const out = new Uint8Array(32);
      for (let j = 0; j < 32; j++, value >>= 8n) out[j] = Number(value & 255n);
      return out;
    };
    const sign = async (msg: Uint8Array) => {
      const r = BigInt(++i);
      const R = ed25519.ExtendedPoint.BASE.multiply(r).toRawBytes();
      const h = sha512(new Uint8Array([...R, ...key.pointBytes, ...msg]));
      const k = BigInt("0x" + bytesToHex(h.slice().reverse())) % ed25519.CURVE.n;
      const S = (r + k * key.scalar) % ed25519.CURVE.n;
      const signature = new Uint8Array([...R, ...le(S)]);
      expect(ed25519.verify(signature, msg, key.pointBytes)).toBe(true);
      return signature;
    };
    await expect(deriveIdentity(sign, opts)).rejects.toThrow(/deterministically/);
    const fixedRandom = (n: number) => new Uint8Array(n).fill(7);
    const id = await deriveIdentity(sign, { ...opts, allowNonDeterministic: true, randomBytes: fixedRandom });
    expect(id.deterministic).toBe(false);
    expect(id.secret).toEqual(new Uint8Array(32).fill(7));
  });
});

describe("login input assembly", () => {
  it("reproduces the exact circuit fixture inputs", async () => {
    const identity = await fixtureIdentity();
    const fx = vectors.circuits.login;
    const session = softwareSession(hexToBytes(vectors.identity.sessionSeed));
    const { input, appId } = buildLoginInput({
      identity,
      origin: vectors.identity.origin,
      claim: {
        kind: "holdsAtLeast",
        mint: hexToBytes(vectors.census.mint),
        amount: BigInt(fx.public.threshold),
        maxAgeSlots: 9000n,
      },
      minSlot: BigInt(fx.public.min_slot),
      session,
      expirySlot: BigInt(vectors.identity.expirySlot),
      home: hexToBytes(vectors.identity.homeAddress),
      policy: fixturePolicy(),
      witness: {
        registry: {
          walletPubkey: hexToBytes(vectors.identity.walletPubkey),
          index: Number(fx.private.reg_index),
          siblings: fx.private.reg_siblings.map(BigInt),
          root: BigInt(fx.public.registry_root),
        },
        census: {
          index: Number(fx.private.cen_index),
          siblings: fx.private.cen_siblings.map(BigInt),
          root: BigInt(fx.public.census_root),
          amount: BigInt(vectors.census.amount),
          slot: BigInt(vectors.census.slot),
        },
      },
    });
    expect(appId.toString()).toBe(fx.public.app_id);
    for (const [k, v] of Object.entries(fx.public)) {
      expect(input[k], `public ${k}`).toEqual(v);
    }
    for (const [k, v] of Object.entries(fx.private)) {
      expect(input[k], `private ${k}`).toEqual(v);
    }
  });
});

describe("intents", () => {
  it("signs the fixture intent hash with the session key", async () => {
    const identity = await fixtureIdentity();
    const session = softwareSession(hexToBytes(vectors.identity.sessionSeed));
    const feeds: Policy = {
      ...conservativePolicy(),
      oracleFeeds: [
        { mint: label("usdc mint"), feedId: label("usdc pyth feed"), decimals: 6 },
        { mint: label("sol mint"), feedId: label("sol pyth feed"), decimals: 9 },
      ],
    };
    const { appId: deriveAppId, domainHash } = await import("@ghostlink/common");
    const appId = deriveAppId(identity.sField, domainHash(vectors.identity.origin));
    const pocket = derivePocket(appId, hexToBytes(vectors.identity.homeAddress), feeds);

    const f = vectors.intent.fields;
    const signed = await signIntent(pocket, session, {
      nonce: BigInt(f.nonce),
      inMint: hexToBytes(f.inMint),
      inMax: BigInt(f.inMax),
      outMint: hexToBytes(f.outMint),
      outMin: BigInt(f.outMin),
      deadlineSlot: BigInt(f.deadlineSlot),
    });
    expect(bytesToHex(intentBytes(signed.intent))).toBe(vectors.intent.bytes);
    expect(bytesToHex(signed.hash)).toBe(vectors.intent.hash);
    expect(bytesToHex(policyHash(feeds))).toBe(vectors.policyWithFeeds.hash);
    // The signature verifies under the session public key.
    expect(
      ed25519.verify(signed.signature.signature, signed.hash, session.key32),
    ).toBe(true);
  });
});

describe("action digests", () => {
  it("matches the owner-action fixtures' bound hashes", () => {
    const actionsPath = join(root, "circuits/keys/owner_actions.json");
    if (!existsSync(actionsPath)) return;
    const actions = JSON.parse(readFileSync(actionsPath, "utf8"));
    const FIELD_P =
      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const toField = (b: Uint8Array) => {
      let n = 0n;
      for (const x of b) n = (n << 8n) | BigInt(x);
      return (n % FIELD_P).toString();
    };
    const pocket = bs58.decode(vectors.pdas.pocket.address);
    expect(toField(sweepDigest(pocket, BigInt(actions.sweep.ownerActionNonce)))).toBe(actions.sweep.publicSignals[3]);
    const change = changeHomeBorsh(hexToBytes(actions.newHome));
    expect(toField(changeDigest(pocket, change, BigInt(actions.proposeHome.ownerActionNonce)))).toBe(actions.proposeHome.publicSignals[3]);
  });
});

describe("recovery", () => {
  it("re-derives pockets from the secret and the visited-domain list", async () => {
    const identity = await fixtureIdentity();
    const { recoverPockets, memoryDomainStore, rememberDomain } = await import("../src/domains.js");
    const store = memoryDomainStore();
    rememberDomain(store, vectors.identity.origin);
    rememberDomain(store, vectors.identity.origin); // dedupes
    rememberDomain(store, "https://other.example.org");
    const pockets = recoverPockets(identity.sField, store.load());
    expect(pockets).toHaveLength(2);
    expect(pockets[0]!.appId.toString()).toBe(vectors.identity.appId);
    expect(bs58.encode(pockets[0]!.pocketAddress)).toBe(vectors.pdas.pocket.address);
    // Different origin, unlinkable id.
    expect(pockets[1]!.appId.toString()).not.toBe(vectors.identity.appId);
  });
});

describe("wallet standard facade", () => {
  it("exposes connect and GhostLink sign-in without advertising SIWS or transaction signing", async () => {
    const identity = await fixtureIdentity();
    const { createGhostLinkWallet } = await import("../src/wallet-standard.js");
    const { appId: deriveAppId, domainHash } = await import("@ghostlink/common");
    const appId = deriveAppId(identity.sField, domainHash(vectors.identity.origin));
    const wallet = createGhostLinkWallet({
      login: async () =>
        ({ appId, appIdBase58: "", proof: null as never, signer: null as never, expirySlot: 0n }),
    });
    expect(Object.keys(wallet.features)).toContain("standard:connect");
    expect(Object.keys(wallet.features)).toContain("ghostlink:signIn");
    expect(Object.keys(wallet.features)).not.toContain("solana:signIn");
    expect(Object.keys(wallet.features)).not.toContain("solana:signTransaction");
    const { accounts } = await (wallet.features["standard:connect"] as {
      connect: () => Promise<{ accounts: { address: string }[] }>;
    }).connect();
    expect(accounts[0]!.address).toBe(vectors.pdas.pocket.address);
  });
});

describe("webauthn signature normalization", () => {
  it("converts DER to raw low-S", () => {
    // DER for r = 2, s = 3 (toy values, structure check only).
    const der = new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x00, 0x02, 0x02, 0x02, 0x00, 0x03]);
    const raw = normalizeDerToLowS(der);
    expect(raw.length).toBe(64);
    expect(raw[31]).toBe(2);
    expect(raw[63]).toBe(3);
  });

  it("normalizes real P-256 signatures to low-S that still verify", async () => {
    const { p256 } = await import("@noble/curves/p256");
    const key = label("p256 test key");
    const pub = p256.getPublicKey(key, true);
    let highSeen = 0;
    for (let i = 0; i < 64; i++) {
      const msg = sha256(new Uint8Array([i]));
      const sig = p256.sign(msg, key, { lowS: false });
      if (sig.hasHighS()) highSeen++;
      const raw = normalizeDerToLowS(sig.toDERRawBytes());
      expect(p256.verify(raw, msg, pub, { lowS: true })).toBe(true);
    }
    expect(highSeen).toBeGreaterThan(0);
  });

  it("rejects truncated or trailing-byte DER", () => {
    expect(() => normalizeDerToLowS(new Uint8Array([0x30, 0x08, 0x02, 0x20, 0x01]))).toThrow(/DER/);
    const trailing = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x02, 0x02, 0x01, 0x03, 0xff]);
    expect(() => normalizeDerToLowS(trailing)).toThrow(/trailing/);
  });
});

describe("end-to-end prove and verify (needs built circuits)", () => {
  const wasm = join(root, "circuits/build/login_js/login.wasm");
  const zkey = join(root, "circuits/build/login_dev.zkey");
  it.skipIf(!existsSync(wasm) || !existsSync(zkey))(
    "proves the fixture inputs through snarkjs",
    async () => {
      const snarkjs = await import("snarkjs");
      const fx = vectors.circuits.login;
      const input = { ...fx.public, ...fx.private };
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
      const vk = JSON.parse(
        readFileSync(join(root, "circuits/keys/login_vk.json"), "utf8"),
      );
      expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
    },
    120_000,
  );
});
