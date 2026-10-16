/**
 * Generates fixtures/vectors.json — the shared contract between TypeScript,
 * Rust and circom. Run with `pnpm vectors`. Deterministic: every input is
 * derived from a readable label via SHA-256, so the file never changes
 * unless the protocol does.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { poseidon2, poseidon3 } from "poseidon-lite";
import {
  bytesToHex,
  fieldToBytes32,
  splitBytes32,
  hashToField,
  secretToField,
  commitment,
  registryLeaf,
  censusLeaf,
  domainHash,
  appId,
  ownerTag,
  sessionCommitment,
  homeHash,
  zeroHashes,
  IncrementalTree,
  TREE_DEPTH,
  intentBytes,
  intentHash,
  policyBytes,
  policyHash,
  conservativePolicy,
  registrationMessage,
  frameOffchain,
  registryTreePda,
  bindingPda,
  censusTreePda,
  pocketPda,
  fillStatePda,
  toBase58,
  pk,
  REGISTRY_PROGRAM_ID,
  type Intent,
  type Policy,
} from "../src/index.js";

const label = (name: string): Uint8Array => sha256(new TextEncoder().encode(`ghostlink vector: ${name}`));
const hex = bytesToHex;
const fe = (f: bigint): string => f.toString(10);

// ---- fixed inputs -------------------------------------------------------
// Wallet and session keys are REAL ed25519 keys derived from seed labels,
// so integration tests can sign with them and replay these exact fixtures
// on-chain (the seeds are published here on purpose: test keys only).
const sBytes = label("identity secret");
const walletSeed = label("wallet seed");
const walletPk = ed25519.getPublicKey(walletSeed);
const mint = label("usdc mint");
const sessionSeed = label("session seed");
const sessionPk = ed25519.getPublicKey(sessionSeed);
const home = label("home address");
const origin = "https://app.example.com";
const amount = 150_000_000n;
const slot = 123_456_789n;
const expirySlot = 123_500_000n;

// ---- derived values -----------------------------------------------------
const sField = secretToField(sBytes);
const C = commitment(sField);
const lReg = registryLeaf(walletPk, C);
const lCen = censusLeaf(walletPk, mint, amount, slot);
const dHash = domainHash(origin);
const aId = appId(sField, dHash);
const oTag = ownerTag(sField, dHash);
const sess = sessionCommitment(sessionPk, expirySlot);
const hHash = homeHash(home);

const zeros = zeroHashes();

// small tree: three leaves, roots after each append, path for leaf #1
const tree = new IncrementalTree();
const roots: string[] = [];
for (const leaf of [lReg, C, aId]) {
  tree.append(leaf);
  roots.push(fe(tree.root));
}
const path1 = tree.path(1);

const policy = conservativePolicy();
const pBytes = policyBytes(policy);
const policyFeeds: Policy = {
  ...policy,
  oracleFeeds: [
    { mint, feedId: label('usdc pyth feed'), decimals: 6 },
    { mint: label('sol mint'), feedId: label('sol pyth feed'), decimals: 9 },
  ],
};
const pHash = policyHash(policy);

// The intent fixture commits to the feeds policy — the one integration
// tests install in the pocket, since fills need oracle bindings.
const pocket = pocketPda(aId);
const intent: Intent = {
  pocket: pocket.address,
  nonce: 7n,
  inMint: mint,
  inMax: 25_000_000n,
  outMint: label("sol mint"),
  outMin: 160_000_000n,
  deadlineSlot: 123_456_900n,
  policyHash: policyHash(policyFeeds),
};
const iBytes = intentBytes(intent);
const iHash = intentHash(intent);

const regMsg = registrationMessage({
  commitment: C,
  walletPubkey: walletPk,
  registryProgramId: pk(REGISTRY_PROGRAM_ID),
  cluster: "devnet",
});

const binding = bindingPda(walletPk);
const regTree = registryTreePda();
const cenTree = censusTreePda();
const fill = fillStatePda(pocket.address, intent.nonce);

// ---- circuit input fixtures --------------------------------------------
// Single-leaf trees, so an integration test that performs one real
// registration and one real census snapshot reproduces these exact roots
// on-chain — and the committed proofs then verify there.
const regTreeFx = new IncrementalTree();
regTreeFx.append(lReg);
const regPathFx = regTreeFx.path(0);

const cenTreeFx = new IncrementalTree();
cenTreeFx.append(lCen);
const cenPathFx = cenTreeFx.path(0);

const actionHash = hashToField(label("action payload"));
const threshold = 100_000_000n; // claim: holds at least 100 USDC
const minSlot = 123_450_000n; // within the program's MAX_MIN_SLOT_LAG of the snapshot slot

const mintSplit = splitBytes32(mint);
const pkSplit = splitBytes32(walletPk);

const circuits = {
  login: {
    public: {
      registry_root: fe(regTreeFx.root),
      census_root: fe(cenTreeFx.root),
      domain_hash: fe(dHash),
      app_id: fe(aId),
      mint_hi: fe(mintSplit.hi),
      mint_lo: fe(mintSplit.lo),
      threshold: threshold.toString(),
      min_slot: minSlot.toString(),
      session_commitment: fe(sess),
      home_hash: fe(hHash),
      claim_holdings: "1",
    },
    private: {
      s: fe(sField),
      pk_hi: fe(pkSplit.hi),
      pk_lo: fe(pkSplit.lo),
      reg_index: String(regPathFx.index),
      reg_siblings: regPathFx.siblings.map(fe),
      amount: amount.toString(),
      slot: slot.toString(),
      cen_index: String(cenPathFx.index),
      cen_siblings: cenPathFx.siblings.map(fe),
    },
  },
  owner: {
    public: {
      registry_root: fe(regTreeFx.root),
      domain_hash: fe(dHash),
      app_id: fe(aId),
      action_hash: fe(actionHash),
    },
    private: {
      s: fe(sField),
      pk_hi: fe(pkSplit.hi),
      pk_lo: fe(pkSplit.lo),
      reg_index: String(regPathFx.index),
      reg_siblings: regPathFx.siblings.map(fe),
    },
  },
};

const vectors = {
  comment:
    "Shared test vectors. Field elements are decimal strings; byte arrays are lowercase hex. Regenerate with `pnpm vectors` in packages/common; Rust and circom tests must match these exactly.",
  field: {
    prime: fe(21888242871839275222246405745257275088548364400416034343698204186575808495617n),
    split: {
      input: hex(walletPk),
      hi: fe(splitBytes32(walletPk).hi),
      lo: fe(splitBytes32(walletPk).lo),
    },
    hashToField: { input: hex(sBytes), out: fe(hashToField(sBytes)) },
  },
  poseidon: {
    p2_1_2: fe(poseidon2([1n, 2n])),
    p3_1_2_3: fe(poseidon3([1n, 2n, 3n])),
  },
  identity: {
    sBytes: hex(sBytes),
    sField: fe(sField),
    commitment: fe(C),
    walletSeed: hex(walletSeed),
    sessionSeed: hex(sessionSeed),
    walletPubkey: hex(walletPk),
    walletBase58: toBase58(walletPk),
    registryLeaf: fe(lReg),
    origin,
    domainHash: fe(dHash),
    appId: fe(aId),
    ownerTag: fe(oTag),
    sessionPubkey: hex(sessionPk),
    expirySlot: expirySlot.toString(),
    sessionCommitment: fe(sess),
    homeAddress: hex(home),
    homeHash: fe(hHash),
  },
  census: {
    mint: hex(mint),
    amount: amount.toString(),
    slot: slot.toString(),
    leaf: fe(lCen),
  },
  merkle: {
    depth: TREE_DEPTH,
    zeros: zeros.map(fe),
    emptyRoot: fe(zeros[TREE_DEPTH]!),
    appended: [fe(lReg), fe(C), fe(aId)],
    rootsAfterEachAppend: roots,
    pathForLeaf1: { index: path1.index, siblings: path1.siblings.map(fe) },
  },
  policy: {
    bytes: hex(pBytes),
    hash: hex(pHash),
    fields: {
      dailyCapUsdE6: policy.dailyCapUsdE6.toString(),
      maxSlippageBps: policy.maxSlippageBps,
      bigActionThresholdUsdE6: policy.bigActionThresholdUsdE6.toString(),
      noOracleCapUsdE6: policy.noOracleCapUsdE6.toString(),
      sessionMaxSlots: policy.sessionMaxSlots.toString(),
    },
  },
  intent: {
    fields: {
      pocket: hex(intent.pocket),
      nonce: intent.nonce.toString(),
      inMint: hex(intent.inMint),
      inMax: intent.inMax.toString(),
      outMint: hex(intent.outMint),
      outMin: intent.outMin.toString(),
      deadlineSlot: intent.deadlineSlot.toString(),
      policyHash: hex(intent.policyHash),
    },
    bytes: hex(iBytes),
    hash: hex(iHash),
  },
  registration: {
    messageAscii: new TextDecoder().decode(regMsg),
    messageHex: hex(regMsg),
    framedHex: hex(frameOffchain(regMsg)),
  },
  policyWithFeeds: {
    bytes: hex(policyBytes(policyFeeds)),
    hash: hex(policyHash(policyFeeds)),
  },
  circuits,
  pdas: {
    registryTree: { address: toBase58(regTree.address), bump: regTree.bump },
    binding: { address: toBase58(binding.address), bump: binding.bump },
    censusTree: { address: toBase58(cenTree.address), bump: cenTree.bump },
    pocket: { address: toBase58(pocket.address), bump: pocket.bump, appId: fe(aId) },
    fillState: { address: toBase58(fill.address), bump: fill.bump },
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "vectors.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${out}`);
