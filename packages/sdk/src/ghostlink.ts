/**
 * The GhostLink facade (build plan section 8). Thin wiring over the pure
 * modules: identity, session, login, pocket. Network calls go through
 * injectable clients so apps, tests and self-hosters can swap endpoints.
 */
import {
  Cluster,
  FIELD_PRIME,
  FieldElement,
  IncrementalTree,
  Policy,
  TREE_DEPTH,
  bytesToHex,
  conservativePolicy,
  fieldToBytes32,
  hexToBytes,
  homeHash,
  intentHash,
  pocketAuthorizationContext,
  toBase58,
  type CensusLatestResponse,
  type IntentRequest,
  type IntentSubmission,
  type LeavesResponse,
  type OpenSessionRequest,
  type PathResponse,
  type PolicyDto,
  type RootsResponse,
  type TxResponse,
} from "@ghostlink/common";
import type { DerivedIdentity } from "./identity.js";
import {
  buildLoginInput,
  proveLogin,
  verifyWitness,
  type Claim,
  type LoginProof,
  type LoginWitnessData,
  type Prover,
} from "./login.js";
import { copySessionPublicKey, softwareSession, type SessionPublicKey, type SessionSigner } from "./session.js";
import {
  derivePocket,
  fundingOptions,
  signIntent,
  type FundingOptions,
  type IntentParams,
  type PocketHandle,
  type SignedIntent,
} from "./pocket.js";

export interface GhostLinkConfig {
  /** V2 is localnet-only until a fresh deployment and migration are verified. */
  cluster: Cluster;
  indexer: string;
  relayer?: string;
  solver?: string;
  actions?: string;
  prover?: Prover;
  /**
   * Node/test only: the origin to scope identities to. In the browser the
   * SDK always uses window.location.origin and ignores this.
   */
  origin?: string;
  fetchFn?: typeof fetch;
}

export interface GhostLinkAuthorization {
  appId: FieldElement;
  appIdBase58: string;
  proof: LoginProof;
  /** Public key descriptor, with no signing function or private key. */
  signer: SessionPublicKey;
  expirySlot: bigint;
}

export interface GhostLinkSession extends GhostLinkAuthorization {
  signer: SessionSigner;
}

export interface SessionAuthorizationParams {
  identity: DerivedIdentity;
  claim?: Claim;
  minSlot?: bigint;
  currentSlot?: bigint;
  witness: LoginWitnessData;
  session: SessionPublicKey;
  /** Must exceed every previous session expiry for this pocket. */
  expirySlot: bigint;
  home: Uint8Array;
  /** Exact owner-approved policy. Renewal must use the current confirmed policy. */
  policy: Policy;
}

export class GhostLink {
  readonly config: GhostLinkConfig;
  private readonly fetchFn: typeof fetch;

  private constructor(config: GhostLinkConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  static async init(config: GhostLinkConfig): Promise<GhostLink> {
    if (config.cluster !== "localnet") {
      throw new Error("This V2 SDK has no verified devnet or mainnet deployment; use localnet");
    }
    return new GhostLink(config);
  }

  /** Origin used by this facade; callers holding the secret still control it. */
  origin(): string {
    if (typeof window !== "undefined" && window.location?.origin) {
      return window.location.origin;
    }
    if (!this.config.origin) throw new Error("origin required outside the browser");
    return this.config.origin;
  }

  // ---- indexer ----------------------------------------------------------

  private async getJson<T>(base: string, path: string): Promise<T> {
    const res = await this.fetchFn(`${base}${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async postJson<T>(base: string, path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async roots(tree: "registry" | "census"): Promise<RootsResponse> {
    return this.getJson(this.config.indexer, `/roots/${tree}`);
  }

  /**
   * Fetches a Merkle path and checks that it is well-formed and hashes to
   * the served root. Integrity against the chain is settled on-chain: the
   * pocket only accepts roots from the 128-root ring, so a lying indexer
   * can waste a proof but never forge one.
   */
  async verifiedPath(
    tree: "registry" | "census",
    leafIndex: number,
    leaf: FieldElement,
  ): Promise<{ index: number; siblings: FieldElement[]; root: FieldElement }> {
    if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= 2 ** TREE_DEPTH) {
      throw new Error("leaf index out of range");
    }
    const p = await this.getJson<PathResponse>(this.config.indexer, `/path/${tree}/${leafIndex}`);
    if (p.index !== leafIndex) throw new Error(`indexer answered for leaf ${p.index}, asked ${leafIndex}`);
    if (!Array.isArray(p.siblings) || p.siblings.length !== TREE_DEPTH) {
      throw new Error(`indexer served a ${tree} path of the wrong depth`);
    }
    const witness = {
      index: p.index,
      siblings: p.siblings.map(fieldFromDecimal),
      root: fieldFromDecimal(p.root),
    };
    if (!verifyWitness(leaf, witness)) {
      throw new Error(`indexer served a bad ${tree} path`);
    }
    return witness;
  }

  /**
   * Builds a witness WITHOUT telling the indexer which leaf you want:
   * downloads the whole tree (pages of leaves), rebuilds it locally and
   * reads the path off it. The request reveals nothing about the wallet
   * — the privacy-preserving choice while the tree is small enough
   * (default cap 50,000 leaves; a 26-hash append per leaf in JS).
   */
  async localWitness(
    tree: "registry" | "census",
    leaf: FieldElement,
    maxLeaves = 50_000,
  ): Promise<{ index: number; siblings: FieldElement[]; root: FieldElement }> {
    if (!Number.isSafeInteger(maxLeaves) || maxLeaves < 0 || maxLeaves > 2 ** TREE_DEPTH) {
      throw new Error("local-witness cap is out of range");
    }
    const local = new IncrementalTree();
    let index = -1;
    let from = 0;
    let snapshotSize: number | undefined;
    for (;;) {
      const page = await this.getJson<LeavesResponse>(this.config.indexer, `/leaves/${tree}?from=${from}&limit=5000`);
      if (!page || !Number.isSafeInteger(page.nextIndex) || page.nextIndex < from ||
        !Array.isArray(page.leaves) || page.from !== from || page.leaves.length > 5000 ||
        page.leaves.length > page.nextIndex - from) {
        throw new Error("indexer served a bad leaves page");
      }
      if (page.nextIndex > maxLeaves) {
        throw new Error(`${tree} tree has ${page.nextIndex} leaves, above the local-witness cap of ${maxLeaves}`);
      }
      snapshotSize ??= page.nextIndex;
      if (page.nextIndex < snapshotSize || (page.leaves.length === 0 && from < snapshotSize)) {
        throw new Error("indexer served an incomplete leaves snapshot");
      }
      // Finish the prefix announced on page one, even if new leaves are
      // appended while downloading. Never chase a growing tree forever.
      const values = page.leaves.slice(0, snapshotSize - from);
      for (const raw of values) {
        const value = fieldFromDecimal(raw);
        const i = local.append(value);
        if (value === leaf && index < 0) index = i;
      }
      from += values.length;
      if (from === snapshotSize) break;
    }
    if (index < 0) throw new Error(`leaf is not in the ${tree} tree`);
    const path = local.path(index);
    return { index, siblings: path.siblings, root: local.root };
  }

  async latestCensus(wallet: Uint8Array, mint: Uint8Array): Promise<CensusLatestResponse> {
    return this.getJson(
      this.config.indexer,
      `/census/latest?wallet=${toBase58(wallet)}&mint=${toBase58(mint)}`,
    );
  }

  // ---- login -------------------------------------------------------------

  /**
   * Produces a login proof for this origin. The witness data (registry
   * binding + census snapshot paths) must already be gathered — see
   * `verifiedPath`; the demo app and services wire this end-to-end.
   */
  async prove(params: {
    identity: DerivedIdentity;
    claim?: Claim;
    /** Explicit min_slot, or give `currentSlot` and the claim's maxAgeSlots applies. */
    minSlot?: bigint;
    currentSlot?: bigint;
    witness: LoginWitnessData;
    session?: SessionSigner;
    /**
     * Must be later than every session this pocket had before (the pocket
     * enforces it as a replay guard): use currentSlot + policy.sessionMaxSlots.
     */
    expirySlot: bigint;
    home: Uint8Array;
    /** Omit for off-chain login; supply explicitly to authorize a pocket. */
    policy?: Policy;
  }): Promise<GhostLinkSession> {
    if (!this.config.prover) throw new Error("no prover configured");
    const signer = params.session ?? softwareSession();
    const authorization = await this.prepareAuthorization({ ...params, session: signer });
    return { ...authorization, signer };
  }

  /**
   * Run on the user's trusted device to authorize a bot's PUBLIC session key.
   * The bot keeps its session secret; the user's identity and proof inputs
   * never go to the bot. This prepares a proof, not an on-chain activation:
   * openSession must confirm before the bot trades. Show the user the bot,
   * home, policy and expiry, and authenticate the key handoff first.
   */
  async authorizeSession(params: SessionAuthorizationParams): Promise<GhostLinkAuthorization> {
    // A remote P-256 key does not establish that a hardware authenticator
    // created it. Never classify a bot-supplied key as passkey-held authority.
    if (params.session?.kind !== 0) throw new Error("Delegated bots require an Ed25519 session public key");
    if (!params.policy) throw new Error("Bot authorization requires an explicit approved policy");
    return this.prepareAuthorization(params);
  }

  private async prepareAuthorization(params: Omit<SessionAuthorizationParams, "policy"> & { policy?: Policy }): Promise<GhostLinkAuthorization> {
    if (!this.config.prover) throw new Error("no prover configured");
    const signer = copySessionPublicKey(params.session);
    const { input, appId } = buildLoginInput({
      identity: params.identity,
      origin: this.origin(),
      claim: params.claim,
      minSlot: params.minSlot,
      currentSlot: params.currentSlot,
      session: signer,
      expirySlot: params.expirySlot,
      home: params.home,
      witness: params.witness,
      policy: params.policy,
    });
    const proof = await proveLogin(this.config.prover, input, appId);
    return {
      appId,
      appIdBase58: toBase58(fieldBytes(appId)),
      proof,
      signer,
      expirySlot: params.expirySlot,
    };
  }

  // ---- pocket -------------------------------------------------------------

  pocketFor(session: GhostLinkAuthorization, home: Uint8Array, policy?: Policy): PocketHandle {
    const pocket = derivePocket(session.appId, home, policy ?? conservativePolicy());
    this.checkPocketAuthorization(session, pocket);
    return pocket;
  }

  private checkPocketAuthorization(session: GhostLinkAuthorization, pocket: PocketHandle): void {
    const signals = session.proof.publicSignals;
    if (signals.length !== 12 || fieldFromDecimal(signals[11]) !== pocketAuthorizationContext(pocket.policy, session.signer.kind)
      || fieldFromDecimal(signals[9]) !== homeHash(pocket.home)
      || fieldFromDecimal(signals[3]) !== session.appId || pocket.appId !== session.appId) {
      throw new Error("Pocket policy, home or deployment does not match the approved V2 authorization");
    }
  }

  funding(pocket: PocketHandle): FundingOptions {
    if (!this.config.actions) throw new Error("no actions endpoint configured");
    return fundingOptions(pocket, this.config.actions);
  }

  /**
   * Fetches the Blink's metadata and refuses it unless the endpoint names
   * the very pocket address derived here. This detects metadata mismatches
   * only: the Actions server still supplies the eventual transaction, whose
   * destination and instructions must be checked before a wallet signs it.
   */
  async verifyFunding(options: FundingOptions): Promise<FundingOptions> {
    const meta = await this.getJson<{ pocket?: string }>(options.blinkUrl, "");
    if (meta.pocket !== options.address) {
      throw new Error(`funding endpoint names pocket ${meta.pocket ?? "(none)"}, expected ${options.address}`);
    }
    return options;
  }

  /**
   * Opens (or rotates) the pocket session through the relayer. Roots and
   * the domain hash come from the proof's own public signals, so they can
   * never disagree with what was proved.
   */
  async openSession(
    session: GhostLinkAuthorization,
    pocket: PocketHandle,
    claimFields: { mint: Uint8Array; threshold: bigint; minSlot: bigint; claim: boolean },
    roots?: { registry: FieldElement; census: FieldElement },
    domainHash?: FieldElement,
  ): Promise<TxResponse> {
    if (!this.config.relayer) throw new Error("no relayer configured");
    this.checkPocketAuthorization(session, pocket);
    const signals = session.proof.publicSignals;
    const bound = {
      registry: roots?.registry ?? fieldFromDecimal(signals[0]),
      census: roots?.census ?? fieldFromDecimal(signals[1]),
      domainHash: domainHash ?? fieldFromDecimal(signals[2]),
    };
    const req: OpenSessionRequest = {
      proofAHex: bytesToHex(session.proof.proof.a),
      proofBHex: bytesToHex(session.proof.proof.b),
      proofCHex: bytesToHex(session.proof.proof.c),
      registryRootHex: bytesToHex(fieldBytes(bound.registry)),
      censusRootHex: bytesToHex(fieldBytes(bound.census)),
      domainHashHex: bytesToHex(fieldBytes(bound.domainHash)),
      appIdHex: bytesToHex(fieldBytes(session.appId)),
      mint: toBase58(claimFields.mint),
      threshold: claimFields.threshold.toString(),
      minSlot: claimFields.minSlot.toString(),
      claimHoldings: claimFields.claim,
      sessionKind: session.signer.kind,
      sessionKeyHex: bytesToHex(session.signer.key33),
      sessionExpirySlot: session.expirySlot.toString(),
      home: toBase58(pocket.home),
      policy: policyToDto(pocket.policy),
    };
    return this.postJson(this.config.relayer, "/open-session", req);
  }

  async submitIntent(
    pocket: PocketHandle,
    session: SessionSigner,
    params: IntentParams,
  ): Promise<{ signed: SignedIntent; tx: IntentSubmission }> {
    if (!this.config.solver) throw new Error("no solver configured");
    const publicKey = copySessionPublicKey(session);
    const signed = await signIntent(pocket, session, params);
    return { signed, tx: await this.submitSignedIntent(signed, publicKey) };
  }

  /** Retry an already-signed intent without changing its nonce or prompting the signer again. */
  async submitSignedIntent(signed: SignedIntent, session: SessionPublicKey): Promise<IntentSubmission> {
    if (!this.config.solver) throw new Error("no solver configured");
    const key = copySessionPublicKey(session);
    const expectedHash = bytesToHex(intentHash(signed.intent));
    if (expectedHash !== bytesToHex(signed.hash)) throw new Error("signed intent was mutated");
    const req: IntentRequest = {
      pocket: toBase58(signed.intent.pocket),
      nonce: signed.intent.nonce.toString(),
      inMint: toBase58(signed.intent.inMint),
      inMax: signed.intent.inMax.toString(),
      outMint: toBase58(signed.intent.outMint),
      outMin: signed.intent.outMin.toString(),
      deadlineSlot: signed.intent.deadlineSlot.toString(),
      policyHashHex: bytesToHex(signed.intent.policyHash),
      sessionKind: key.kind,
      signatureHex: bytesToHex(signed.signature.signature),
      sessionKeyHex: bytesToHex(key.kind === 0 ? key.key32 : key.key33),
      webauthn: signed.signature.webauthn
        ? {
            authenticatorDataHex: bytesToHex(signed.signature.webauthn.authenticatorData),
            clientDataJsonUtf8: new TextDecoder().decode(signed.signature.webauthn.clientDataJson),
          }
        : undefined,
    };
    const tx = await this.postJson<IntentSubmission>(this.config.solver, "/intent", req);
    return this.checkedIntentStatus(tx, expectedHash);
  }

  /** Poll the exact intent; a submission receipt is not confirmation. */
  async intentStatus(intentHashHex: string): Promise<IntentSubmission> {
    if (!this.config.solver) throw new Error("no solver configured");
    if (!/^[0-9a-f]{64}$/.test(intentHashHex)) throw new Error("invalid intent hash");
    const response = await this.fetchFn(`${this.config.solver}/intents/${intentHashHex}`);
    if (!response.ok) throw new Error(`solver status: HTTP ${response.status}`);
    return this.checkedIntentStatus(await response.json(), intentHashHex);
  }

  private checkedIntentStatus(value: unknown, expectedHash: string): IntentSubmission {
    const v = value as IntentSubmission;
    if (!v || v.intentHashHex !== expectedHash || !["preparing", "pending", "confirmed", "finalized", "failed", "expired", "unknown"].includes(v.state)) {
      throw new Error("invalid solver submission receipt");
    }
    if (!["preparing", "unknown"].includes(v.state) && (typeof v.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v.signature))) throw new Error("missing transaction identity");
    if (["confirmed", "finalized", "failed"].includes(v.state) && (!Number.isSafeInteger(v.slot) || v.slot! < 0 ||
      !["confirmed", "finalized"].includes(v.confirmationStatus ?? ""))) throw new Error("missing confirmation evidence");
    if ((v.state === "confirmed" || v.state === "finalized") && v.confirmationStatus !== v.state) throw new Error("inconsistent confirmation evidence");
    return v;
  }
}

export function policyToDto(p: Policy): PolicyDto {
  return {
    dailyCapUsdE6: p.dailyCapUsdE6.toString(),
    maxSlippageBps: p.maxSlippageBps,
    bigActionThresholdUsdE6: p.bigActionThresholdUsdE6.toString(),
    noOracleCapUsdE6: p.noOracleCapUsdE6.toString(),
    sessionMaxSlots: p.sessionMaxSlots.toString(),
    allowedOutMints: p.allowedOutMints.map(toBase58),
    oracleFeeds: p.oracleFeeds.map((f) => ({
      mint: toBase58(f.mint),
      feedIdHex: bytesToHex(f.feedId),
      decimals: f.decimals,
    })),
  };
}

export function policyFromDto(d: PolicyDto): Policy {
  const bs58decode = (s: string) => hexToBytes(bytesToHex(fromBase58(s)));
  return {
    dailyCapUsdE6: BigInt(d.dailyCapUsdE6),
    maxSlippageBps: d.maxSlippageBps,
    bigActionThresholdUsdE6: BigInt(d.bigActionThresholdUsdE6),
    noOracleCapUsdE6: BigInt(d.noOracleCapUsdE6),
    sessionMaxSlots: BigInt(d.sessionMaxSlots),
    allowedOutMints: d.allowedOutMints.map(bs58decode),
    oracleFeeds: d.oracleFeeds.map((f) => ({
      mint: bs58decode(f.mint),
      feedId: hexToBytes(f.feedIdHex),
      decimals: f.decimals,
    })),
  };
}

const fieldBytes = fieldToBytes32;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** A served field element: canonical decimal and reduced, or an error. */
function fieldFromDecimal(s: unknown): FieldElement {
  if (typeof s !== "string" || s.length > 77 || !DECIMAL.test(s)) throw new Error("indexer served a non-decimal field element");
  const v = BigInt(s);
  if (v >= FIELD_PRIME) throw new Error("indexer served an unreduced field element");
  return v;
}

import { pk as fromBase58 } from "@ghostlink/common";
export { IncrementalTree };
