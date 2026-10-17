/**
 * Proves the fixture inputs with the dev zkeys and verifies both proofs —
 * the end-to-end check that circuit, keys and fixtures agree. Also writes
 * the proofs and public signals to circuits/keys/ so the Rust verifier
 * tests can check the exact same proofs on the program side.
 */
import * as snarkjs from "snarkjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vectors = JSON.parse(readFileSync(join(root, "packages/common/fixtures/vectors.json"), "utf8"));

mkdirSync(join(root, "circuits/keys"), { recursive: true });

for (const name of ["login", "owner"]) {
  const fx = vectors.circuits[name];
  const input = { ...fx.public, ...fx.private };
  const wasm = join(root, `circuits/build/${name}_js/${name}.wasm`);
  const zkey = join(root, `circuits/build/${name}_dev.zkey`);

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  const vk = JSON.parse(readFileSync(join(root, `circuits/keys/${name}_vk.json`), "utf8"));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) {
    console.error(`${name}: proof did NOT verify`);
    process.exit(1);
  }
  // Keep proof + signals for the Rust cross-check (committed fixtures),
  // including bytes converted by @ghostlink/common's proofToBytes so the
  // Rust verifier test proves the TS converter correct.
  const { proofToBytes } = await import("../../packages/common/dist/index.js");
  const bytes = proofToBytes(proof);
  const toHex = (u) => Buffer.from(u).toString("hex");
  writeFileSync(
    join(root, `circuits/keys/${name}_proof.json`),
    JSON.stringify(
      { proof, publicSignals, bytes: { a: toHex(bytes.a), b: toHex(bytes.b), c: toHex(bytes.c) } },
      null,
      2,
    ) + "\n",
  );
  console.log(`${name}: proof verified (${publicSignals.length} public signals)`);
}

// ---- owner proofs for the pocket's on-chain actions --------------------
// Each binds action_hash = (SHA-256 of the action bytes) mod p, with the
// action bytes laid out exactly as programs/pocket builds them.
const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const sha = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const toField = (buf) => {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return (n % FIELD_P).toString(10);
};
const label = (name) => sha(Buffer.from(`ghostlink vector: ${name}`));

const pocketBytes = bs58.decode(vectors.pdas.pocket.address);
const newHome = label("new home address");
// borsh(Change::Home(pubkey)) = enum tag 0 then the 32-byte key.
const changeBytes = Buffer.concat([Buffer.from([0]), newHome]);
const changeDigest = sha(changeBytes);

const actionSpecs = {
  sweep: ["sweep", 0n],
  sweepAfterAction: ["sweep", 1n],
  revoke: ["revoke", 0n],
  proposeHome: ["change", 1n],
  cancel: ["cancel", 2n],
  reproposeHome: ["change", 3n],
  revokeAfterChanges: ["revoke", 5n],
};

const ownerFx = vectors.circuits.owner;
const ownerWasm = join(root, "circuits/build/owner_js/owner.wasm");
const ownerZkey = join(root, "circuits/build/owner_dev.zkey");
const ownerVk = JSON.parse(readFileSync(join(root, "circuits/keys/owner_vk.json"), "utf8"));
const out = { newHome: newHome.toString("hex") };
for (const [name, [tag, nonce]] of Object.entries(actionSpecs)) {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  const payload = tag === "change" || tag === "cancel" ? [changeDigest] : [];
  const digest = sha(Buffer.from(`ghostlink:${tag}:v1`), pocketBytes, ...payload, nonceBytes);
  const input = {
    ...ownerFx.private,
    registry_root: ownerFx.public.registry_root,
    domain_hash: ownerFx.public.domain_hash,
    app_id: ownerFx.public.app_id,
    action_hash: toField(digest),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, ownerWasm, ownerZkey);
  if (!(await snarkjs.groth16.verify(ownerVk, publicSignals, proof))) {
    console.error(`owner action ${name}: proof did NOT verify`);
    process.exit(1);
  }
  out[name] = { ownerActionNonce: nonce.toString(), proof, publicSignals };
  console.log(`owner action ${name}: proof verified`);
}
writeFileSync(join(root, "circuits/keys/owner_actions.json"), JSON.stringify(out, null, 2) + "\n");

// ---- a second login proof for a P-256 (passkey) session ----------------
// session_commitment = Poseidon(hi, lo, expiry) over SHA-256 of the
// 33-byte compressed P-256 public key (state.rs, session_key32).
const { p256 } = await import("@noble/curves/p256");
const common = await import("../../packages/common/dist/index.js");

const p256Seed = label("p256 session seed");
const p256Pub = p256.getPublicKey(p256Seed, true); // compressed, 33 bytes
const key32 = sha(Buffer.from(p256Pub));
// One slot later than the Ed25519 fixture session: the pocket requires
// every new session to expire after the previous one (replay guard), and
// the itests rotate from the Ed25519 session to this one.
const expiry = BigInt(vectors.identity.expirySlot) + 1n;
const p256Commitment = common.sessionCommitment(key32, expiry);

const loginFx = vectors.circuits.login;
const fixturePolicy = {
  ...common.conservativePolicy(),
  oracleFeeds: vectors.policyWithFeeds.feeds.map((f) => ({
    mint: common.hexToBytes(f.mint), feedId: common.hexToBytes(f.feedId), decimals: f.decimals,
  })),
};
const p256Input = {
  ...loginFx.public,
  ...loginFx.private,
  session_commitment: p256Commitment.toString(10),
  authorization_context: common.pocketAuthorizationContext(fixturePolicy, 1).toString(),
};
const { proof: p256Proof, publicSignals: p256Signals } = await snarkjs.groth16.fullProve(
  p256Input,
  join(root, "circuits/build/login_js/login.wasm"),
  join(root, "circuits/build/login_dev.zkey"),
);
const loginVk = JSON.parse(readFileSync(join(root, "circuits/keys/login_vk.json"), "utf8"));
if (!(await snarkjs.groth16.verify(loginVk, p256Signals, p256Proof))) {
  console.error("p256 login proof did NOT verify");
  process.exit(1);
}
writeFileSync(
  join(root, "circuits/keys/login_p256_proof.json"),
  JSON.stringify(
    { seed: p256Seed.toString("hex"), compressedPubkey: Buffer.from(p256Pub).toString("hex"), proof: p256Proof, publicSignals: p256Signals },
    null,
    2,
  ) + "\n",
);
console.log("p256 login proof verified");

// Real proofs for purpose/deployment refusal tests (not mutated fake proofs).
const otherDeployment = common.developmentSessionDeployment();
otherDeployment.pocketProgram = label("other pocket program");
for (const [name, context] of [
  ["offchain", 0n],
  ["other_deployment", common.pocketAuthorizationContext(fixturePolicy, 0, otherDeployment)],
  ["speculative", common.pocketAuthorizationContext({ ...fixturePolicy, speculative: {
    dailyBuyCapUsdE6: 30_000_000n, maxCostExposureUsdE6: 20_000_000n, maxPositions: 2,
    baseMints: fixturePolicy.oracleFeeds.map(f => f.mint),
  } }, 0)],
]) {
  const input = { ...loginFx.public, ...loginFx.private, authorization_context: context.toString() };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input,
    join(root, "circuits/build/login_js/login.wasm"), join(root, "circuits/build/login_dev.zkey"));
  if (!(await snarkjs.groth16.verify(loginVk, publicSignals, proof))) throw new Error(`${name} proof invalid`);
  const bytes = common.proofToBytes(proof);
  writeFileSync(join(root, `circuits/keys/login_${name}_proof.json`), JSON.stringify({ proof, publicSignals,
    bytes: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, Buffer.from(v).toString("hex")])) }, null, 2) + "\n");
  console.log(`${name} login proof verified`);
}
// Renew the same explicitly approved speculative policy after a full day.
const specPolicy = { ...fixturePolicy, speculative: {
  dailyBuyCapUsdE6: 30_000_000n, maxCostExposureUsdE6: 20_000_000n, maxPositions: 2,
  baseMints: fixturePolicy.oracleFeeds.map(f => f.mint),
} };
const renewedExpiry = BigInt(vectors.identity.expirySlot) + 216_000n;
const renewed = { ...loginFx.public, ...loginFx.private, claim_holdings: "0",
  session_commitment: common.sessionCommitment(common.hexToBytes(vectors.identity.sessionPubkey), renewedExpiry).toString(),
  authorization_context: common.pocketAuthorizationContext(specPolicy, 0).toString() };
const renewProof = await snarkjs.groth16.fullProve(renewed,
  join(root, "circuits/build/login_js/login.wasm"), join(root, "circuits/build/login_dev.zkey"));
if (!(await snarkjs.groth16.verify(loginVk, renewProof.publicSignals, renewProof.proof))) throw new Error("renewal proof invalid");
writeFileSync(join(root, "circuits/keys/login_speculative_renew_proof.json"), JSON.stringify(renewProof, null, 2) + "\n");

// Owner proposes returning to the conservative policy. This independent
// Borsh encoder is cross-checked by the real compiled-program action test.
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const conservativeBorsh = Buffer.concat([
  common.u64le(fixturePolicy.dailyCapUsdE6), common.u16le(fixturePolicy.maxSlippageBps),
  common.u64le(fixturePolicy.bigActionThresholdUsdE6), common.u64le(fixturePolicy.noOracleCapUsdE6),
  common.u64le(fixturePolicy.sessionMaxSlots), u32(0), u32(fixturePolicy.oracleFeeds.length),
  ...fixturePolicy.oracleFeeds.flatMap(f => [f.mint, f.feedId, Buffer.from([f.decimals])]), Buffer.from([0]),
]);
const policyChangeDigest = sha(Buffer.from([1]), conservativeBorsh);
const actionHash = toField(sha(Buffer.from("ghostlink:change:v1"), pocketBytes, policyChangeDigest, Buffer.alloc(8)));
const policyProof = await snarkjs.groth16.fullProve({ ...ownerFx.private, ...ownerFx.public, action_hash: actionHash }, ownerWasm, ownerZkey);
if (!(await snarkjs.groth16.verify(ownerVk, policyProof.publicSignals, policyProof.proof))) throw new Error("policy change proof invalid");
writeFileSync(join(root, "circuits/keys/owner_speculative_policy_proof.json"), JSON.stringify(policyProof, null, 2) + "\n");
console.log("speculative renewal and owner policy-change proofs verified");
process.exit(0);
