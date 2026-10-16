/**
 * Login and proving (build plan 4.2).
 *
 * GhostLink.prove uses the current page origin. The pure helpers below
 * accept an explicit origin; code given the identity secret can derive
 * identities for any origin, so keep that secret in a trusted application.
 * Paths are checked against their supplied roots; on-chain or server-side
 * root verification establishes chain integrity.
 */
import {
  FieldElement,
  IncrementalTree,
  TREE_DEPTH,
  appId,
  censusLeaf,
  domainHash,
  homeHash,
  proofToBytes,
  publicSignalsToBytes,
  registryLeaf,
  splitBytes32,
  type ProofBytes,
} from "@ghostlink/common";
import type { DerivedIdentity } from "./identity.js";
import { sessionCommitmentFor, type SessionSigner } from "./session.js";

/** What apps may claim. V1 ships holdsAtLeast; more claims are additive. */
export interface HoldsAtLeastClaim {
  kind: "holdsAtLeast";
  mint: Uint8Array;
  amount: bigint;
  /**
   * How old the census snapshot may be. Turned into the circuit's
   * `min_slot` (= currentSlot − maxAgeSlots) by `buildLoginInput` when
   * `currentSlot` is given; the pocket additionally caps it at ~1 hour.
   */
  maxAgeSlots: bigint;
}
export type Claim = HoldsAtLeastClaim;

/** Merkle data the indexer serves; every path is verified before use. */
export interface MerkleWitness {
  index: number;
  siblings: FieldElement[];
  root: FieldElement;
}

export interface LoginWitnessData {
  registry: MerkleWitness & { walletPubkey: Uint8Array };
  census?: MerkleWitness & { amount: bigint; slot: bigint };
}

export interface CircuitInput {
  [signal: string]: string | string[];
}

/**
 * Runs on the user's device, and only there. The input it receives holds
 * the identity secret and the wallet public key; wiring a remote
 * "proving service" here would hand both to its operator, so never
 * serialize a CircuitInput or send it anywhere.
 */
export interface Prover {
  prove(
    circuit: "login" | "owner",
    input: CircuitInput,
  ): Promise<{ proof: unknown; publicSignals: string[] }>;
}

export interface LoginProof {
  appId: FieldElement;
  /** JSON-serializable proof for @ghostlink/verify on an app's backend. */
  snarkjsProof: object;
  /** Encoded proof for the Solana program, not the off-chain verifier. */
  proof: ProofBytes;
  publicSignals: string[];
  publicInputBytes: Uint8Array[];
}

export function verifyWitness(leaf: FieldElement, w: MerkleWitness): boolean {
  return IncrementalTree.verify(leaf, { index: w.index, siblings: w.siblings }, w.root);
}

/** Assembles login circuit inputs. Pure; network fetching stays outside. */
export function buildLoginInput(params: {
  identity: DerivedIdentity;
  origin: string;
  claim?: HoldsAtLeastClaim;
  /** Explicit `min_slot`; otherwise derived from `currentSlot − claim.maxAgeSlots`. */
  minSlot?: bigint;
  /** The chain's current slot, needed to derive `min_slot` for a claim. */
  currentSlot?: bigint;
  session: SessionSigner;
  expirySlot: bigint;
  home: Uint8Array;
  witness: LoginWitnessData;
}): { input: CircuitInput; appId: FieldElement; domainHash: FieldElement } {
  const { identity, origin, claim, session, expirySlot, home, witness } = params;
  const minSlot = resolveMinSlot(params);
  const dHash = domainHash(origin);
  const id = appId(identity.sField, dHash);
  const pk = splitBytes32(witness.registry.walletPubkey);
  const mint = claim ? splitBytes32(claim.mint) : { hi: 0n, lo: 0n };

  if (!verifyWitness(registryLeaf(witness.registry.walletPubkey, identity.commitment), witness.registry)) {
    throw new Error("invalid registry witness");
  }
  if (claim) {
    if (!witness.census || !verifyWitness(
      censusLeaf(witness.registry.walletPubkey, claim.mint, witness.census.amount, witness.census.slot),
      witness.census,
    )) throw new Error("invalid census witness");
    if (witness.census.amount < claim.amount || witness.census.slot < minSlot) {
      throw new Error("census snapshot does not satisfy the holdings claim");
    }
  }

  const zeroPath = new Array<string>(TREE_DEPTH).fill("0");
  const input: CircuitInput = {
    registry_root: witness.registry.root.toString(),
    census_root: (witness.census?.root ?? 0n).toString(),
    domain_hash: dHash.toString(),
    app_id: id.toString(),
    mint_hi: mint.hi.toString(),
    mint_lo: mint.lo.toString(),
    threshold: (claim?.amount ?? 0n).toString(),
    min_slot: minSlot.toString(),
    session_commitment: sessionCommitmentFor(session, expirySlot).toString(),
    home_hash: homeHash(home).toString(),
    claim_holdings: claim ? "1" : "0",
    s: identity.sField.toString(),
    pk_hi: pk.hi.toString(),
    pk_lo: pk.lo.toString(),
    reg_index: String(witness.registry.index),
    reg_siblings: witness.registry.siblings.map((x) => x.toString()),
    amount: (witness.census?.amount ?? 0n).toString(),
    slot: (witness.census?.slot ?? 0n).toString(),
    cen_index: String(witness.census?.index ?? 0),
    cen_siblings: witness.census?.siblings.map((x) => x.toString()) ?? zeroPath,
  };
  return { input, appId: id, domainHash: dHash };
}

function resolveMinSlot(p: { claim?: HoldsAtLeastClaim; minSlot?: bigint; currentSlot?: bigint }): bigint {
  if (p.minSlot !== undefined) return p.minSlot;
  if (!p.claim) return 0n;
  if (p.currentSlot === undefined) {
    throw new Error("a holdings claim needs minSlot or currentSlot (to apply maxAgeSlots)");
  }
  const m = p.currentSlot - p.claim.maxAgeSlots;
  return m > 0n ? m : 0n;
}

export async function proveLogin(
  prover: Prover,
  input: CircuitInput,
  id: FieldElement,
): Promise<LoginProof> {
  const { proof, publicSignals } = await prover.prove("login", input);
  return {
    appId: id,
    snarkjsProof: proof as object,
    proof: proofToBytes(proof as never),
    publicSignals,
    publicInputBytes: publicSignalsToBytes(publicSignals),
  };
}
