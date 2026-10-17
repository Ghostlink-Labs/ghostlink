import bs58 from "bs58";
import {
  appId, domainHash, FIELD_PRIME, fieldToBytes32, hexToBytes, pocketPda, toBase58,
  type BotConsent, type BotDeployment,
} from "@ghostlink/common";
import {
  ApplicationRegistry, canonicalBotDeployment, canonicalConsentPolicy, consentAddress, consentDecimal,
  consentDigest, consentObject, consentTime,
} from "./applications.js";
import { policyFromDto, type GhostLinkAuthorization } from "./ghostlink.js";
import type { DerivedIdentity } from "./identity.js";
import { buildLoginInput, proveLogin, type Claim, type LoginWitnessData, type Prover } from "./login.js";
import { sessionPublicKey } from "./session.js";

type ReadonlyDeep<T> = T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;
export interface OwnerConsentReview {
  readonly applicationId: string;
  readonly applicationName: string;
  readonly authorizationBaseUrl: string;
  readonly registryDigest: string;
  readonly consentDigest: string;
  readonly consent: ReadonlyDeep<BotConsent>;
}
export interface OwnerConsentExpectations {
  applicationId: string;
  /** Already authenticated by Telegram; a bot-supplied user ID is not authentication. */
  telegramUserId: string;
  identity: Pick<DerivedIdentity, "sField">;
  /** Owner-selected recovery destination and requested expiry, never copied from the response. */
  home: Uint8Array;
  expirySlot: bigint;
}
export interface OwnerConsentOptions {
  registry: ApplicationRegistry;
  /** Trusted confirmed RPC reader. Pass minContextSlot to RPCs supporting it. */
  readChainContext(minContextSlot: number): Promise<{ genesisHash: string; slot: number }>;
  nowSeconds?: () => number;
  /** Node tests/native integrations only. Browser context always uses its real, top-level origin. */
  nodeOwnerOrigin?: string;
}
interface ReviewState {
  consent: BotConsent;
  state: "reviewed" | "proving" | "released" | "cancelled" | "failed";
}
const PUBLIC_SIGNALS = ["registry_root", "census_root", "domain_hash", "app_id", "mint_hi", "mint_lo", "threshold",
  "min_slot", "session_commitment", "home_hash", "claim_holdings", "authorization_context"] as const;

function freeze<T>(value: T): ReadonlyDeep<T> {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as ReadonlyDeep<T>;
}

/**
 * Only instantiate in the trusted owner application. Partners receive public request fields,
 * never this object, the identity secret, witness or prover. Display review before calling prove.
 */
export class OwnerConsentController {
  #registry: ApplicationRegistry;
  #chain: OwnerConsentOptions["readChainContext"];
  #clock: () => number;
  #nodeOrigin?: string;
  #slot = 0;
  #time = 0;
  #reviews = new WeakMap<OwnerConsentReview, ReviewState>();

  constructor(options: OwnerConsentOptions) {
    this.#registry = options.registry;
    this.#chain = options.readChainContext;
    this.#clock = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.#nodeOrigin = options.nodeOwnerOrigin;
  }
  #now(): number {
    this.#time = Math.max(this.#time, consentTime(this.#clock()));
    return this.#time;
  }
  #context() {
    const manifest = this.#registry.snapshot(this.#now());
    if (typeof window !== "undefined") {
      if (window.location.origin !== manifest.ownerOrigin || window.top !== window) throw new Error("trusted top-level owner application required");
    } else if (this.#nodeOrigin !== manifest.ownerOrigin) throw new Error("trusted owner origin required outside browser");
    return manifest;
  }
  async #head(deployment: BotDeployment): Promise<bigint> {
    const head = await this.#chain(this.#slot);
    if (head.genesisHash !== deployment.genesisHash) throw new Error("owner RPC genesis mismatch");
    consentTime(head.slot);
    if (head.slot < this.#slot) throw new Error("owner RPC context regressed");
    this.#slot = head.slot;
    return BigInt(head.slot);
  }
  #current(review: OwnerConsentReview, record: ReviewState, expected: ReviewState["state"]): void {
    this.#context();
    if (record.state !== expected) throw new Error("consent is no longer available");
    if (this.#registry.digest !== review.registryDigest) throw new Error("application registry changed; review again");
    this.#registry.application(review.applicationId, this.#now());
    if (record.consent.expiresAt <= this.#now()) throw new Error("consent expired; request again");
  }

  async review(rawStatus: unknown, expected: OwnerConsentExpectations): Promise<OwnerConsentReview> {
    const manifest = this.#context(), registryDigest = this.#registry.digest;
    const applicationId = expected.applicationId, application = this.#registry.application(applicationId, this.#now());
    const userId = consentDecimal(expected.telegramUserId, (1n << 52n) - 1n);
    if (userId === "0") throw new Error("authenticated Telegram user required");
    if (expected.identity.sField <= 0n || expected.identity.sField >= FIELD_PRIME) throw new Error("invalid owner identity");
    const id = appId(expected.identity.sField, domainHash(application.appOrigin)).toString();
    const home = consentAddress(bs58.encode(expected.home)), expiry = consentDecimal(expected.expirySlot.toString());
    const status = consentObject(rawStatus, ["state", "consent"], ["confirmedSlot", "observedSlot"]);
    if (status.state !== "pending" || status.confirmedSlot !== undefined) throw new Error("pending consent required");
    if (status.observedSlot !== undefined) consentTime(status.observedSlot);
    const c = consentObject(status.consent, ["version", "id", "botId", "userId", "appOrigin", "deployment", "appId", "pocket", "home",
      "policy", "sessionKeyHex", "sessionExpirySlot", "createdAt", "expiresAt"]);
    if (c.version !== 1 || typeof c.id !== "string" || !/^[0-9a-f]{64}$/.test(c.id) ||
      c.botId !== application.telegramBotId || c.userId !== userId || c.appOrigin !== application.appOrigin ||
      c.appId !== id || c.home !== home || c.sessionExpirySlot !== expiry ||
      c.pocket !== toBase58(pocketPda(BigInt(id)).address)) throw new Error("consent does not match owner request");
    const deployment = canonicalBotDeployment(c.deployment), policy = canonicalConsentPolicy(c.policy);
    if (consentDigest(deployment) !== consentDigest(manifest.deployment) || consentDigest(policy) !== consentDigest(application.policy)) {
      throw new Error("consent deployment or policy is not approved");
    }
    if (typeof c.sessionKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(c.sessionKeyHex)) throw new Error("invalid bot session key");
    sessionPublicKey(0, hexToBytes(c.sessionKeyHex));
    const createdAt = consentTime(c.createdAt), expiresAt = consentTime(c.expiresAt);
    if (createdAt > this.#now() + 30 || expiresAt <= createdAt || expiresAt - createdAt > 900) throw new Error("invalid consent lifetime");
    const consent = structuredClone({ ...c, deployment, policy }) as BotConsent;
    const observedSlot = status.observedSlot;
    const slot = await this.#head(deployment);
    if ((observedSlot !== undefined && BigInt(observedSlot) > slot) || BigInt(expiry) <= slot ||
      BigInt(expiry) > slot + BigInt(policy.sessionMaxSlots)) throw new Error("consent session expiry or chain context is invalid");
    const review = freeze({ applicationId, applicationName: application.name, authorizationBaseUrl: application.authorizationBaseUrl,
      registryDigest, consentDigest: consentDigest(consent), consent: structuredClone(consent) });
    const record: ReviewState = { consent, state: "reviewed" };
    this.#current(review, record, "reviewed");
    this.#reviews.set(review, record);
    return review;
  }

  cancel(review: OwnerConsentReview): void {
    const record = this.#reviews.get(review);
    if (!record || ["released", "failed"].includes(record.state)) throw new Error("consent cannot be cancelled locally");
    record.state = "cancelled";
  }

  /** Local proof only. A returned proof is public authorization, not confirmation of an on-chain session. */
  async prove(review: OwnerConsentReview, params: {
    identity: DerivedIdentity; witness: LoginWitnessData; prover: Prover; claim?: Claim; minSlot?: bigint;
  }): Promise<GhostLinkAuthorization> {
    const record = this.#reviews.get(review);
    if (!record) throw new Error("review belongs to a different owner controller");
    this.#current(review, record, "reviewed");
    record.state = "proving";
    try {
      // Snapshot before RPC/prover awaits, so caller mutation cannot replace the reviewed identity or inputs.
      const identity = structuredClone(params.identity), witness = structuredClone(params.witness);
      const claim = params.claim && structuredClone(params.claim), minSlot = params.minSlot, prover = params.prover;
      const c = record.consent, expirySlot = BigInt(c.sessionExpirySlot);
      const slot = await this.#head(c.deployment);
      this.#current(review, record, "proving");
      if (expirySlot <= slot) throw new Error("bot session expired before proving");
      const session = sessionPublicKey(0, hexToBytes(c.sessionKeyHex));
      const built = buildLoginInput({ identity, witness, claim, minSlot, currentSlot: slot, session, expirySlot,
        origin: c.appOrigin, home: bs58.decode(c.home), policy: policyFromDto(c.policy), deployment: {
          pocketProgram: bs58.decode(c.deployment.pocketProgram), registryProgram: bs58.decode(c.deployment.registryProgram),
          censusProgram: bs58.decode(c.deployment.censusProgram),
        } });
      if (built.appId.toString() !== c.appId) throw new Error("owner identity changed after review");
      const expectedSignals = PUBLIC_SIGNALS.map(k => built.input[k]);
      const proof = structuredClone(await proveLogin(prover, built.input, built.appId));
      if (proof.publicSignals.length !== expectedSignals.length || proof.publicSignals.some((v, i) => v !== expectedSignals[i])) {
        throw new Error("prover returned a different authorization");
      }
      this.#current(review, record, "proving");
      if (expirySlot <= await this.#head(c.deployment)) throw new Error("bot session expired during proving");
      this.#current(review, record, "proving");
      record.state = "released";
      return { appId: built.appId, appIdBase58: toBase58(fieldToBytes32(built.appId)), proof, signer: session, expirySlot };
    } catch (error) {
      record.state = "failed";
      throw error;
    }
  }
}
