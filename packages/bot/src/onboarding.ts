import { createHash, randomBytes } from "node:crypto";
import { PublicKey, type AccountInfo, type GetAccountInfoConfig, type RpcResponseAndContext } from "@solana/web3.js";
import {
  FIELD_PRIME, bytesToHex, domainHash, fieldToBytes32, hexToBytes, pocketPda, policyHash, toBase58,
  type Policy,
} from "@ghostlink/common";
import { derivePocket, policyFromDto, policyToDto, signIntent, softwareSession, type IntentParams, type SignedIntent } from "@ghostlink/sdk";
import { BorshWriter, readPocketAccount, writePolicy } from "@ghostlink/service-kit";
import { BotKeyStore } from "./store.js";
import { verifyTelegramInitData, type TelegramIdentity } from "./telegram.js";
import type { BotConsent, BotDeployment, ConsentStatus } from "./types.js";
import { copyParams, decodeIntent, digest, orderFingerprint, orderStatus, signedOrder, type BotIntentParams, type BotOrderStatus } from "./orders.js";

export interface AuthorizationChain {
  getGenesisHash(): Promise<string>;
  getSlot(commitment: "confirmed"): Promise<number>;
  getAccountInfoAndContext(address: PublicKey, config: GetAccountInfoConfig): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>>;
}

export interface BotOnboardingOptions {
  botToken: string;
  store: BotKeyStore;
  chain: AuthorizationChain;
  /** Vetted partner origin chosen by the operator, never by a request body. */
  appOrigin: string;
  deployment: BotDeployment;
  /** Exact permissions presented for consent. Config changes affect new requests only. */
  policy: Policy;
  requestTtlSeconds?: number;
  nowSeconds?: () => number;
}

export interface CreateConsent {
  /** Random 16+ bytes, hex encoded. Reuse only when retrying the same request. */
  requestKey: string;
  /** Derived locally by the trusted owner UI for the vetted application origin. */
  appId: string;
  home: string;
  sessionExpirySlot: string;
}

export function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) throw new Error("a canonical HTTPS origin is required");
  return url.origin;
}

const equal = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const U64_MAX = (1n << 64n) - 1n;

function decimal(value: string, max: bigint, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,76})$/.test(value)) throw new Error(`invalid ${label}`);
  const n = BigInt(value);
  if (n > max) throw new Error(`invalid ${label}`);
  return n;
}

/** Headless backend contract. The owner's proving/consent UI is a separate trusted application. */
export class BotOnboarding {
  #token: string;
  #store: BotKeyStore;
  #chain: AuthorizationChain;
  #origin: string;
  #deployment: BotDeployment;
  #policy: Policy;
  #ttl: number;
  #clock: () => number;

  constructor(options: BotOnboardingOptions) {
    if (options.deployment.cluster !== "localnet") throw new Error("V2 bot onboarding is localnet-only until a deployment is verified");
    this.#token = options.botToken;
    this.#store = options.store;
    this.#chain = options.chain;
    this.#origin = exactHttpsOrigin(options.appOrigin);
    this.#deployment = structuredClone(options.deployment);
    for (const id of [options.deployment.genesisHash, options.deployment.pocketProgram, options.deployment.registryProgram, options.deployment.censusProgram]) {
      if (new PublicKey(id).toBase58() !== id) throw new Error("invalid deployment identity");
    }
    if (["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(options.deployment.genesisHash)) {
      throw new Error("V2 bot onboarding requires a disposable local validator");
    }
    writePolicy(new BorshWriter(), options.policy);
    if (options.policy.maxSlippageBps > 10_000 || options.policy.sessionMaxSlots === 0n) throw new Error("invalid onboarding policy");
    this.#policy = policyFromDto(policyToDto(options.policy));
    this.#ttl = options.requestTtlSeconds ?? 300;
    if (!Number.isInteger(this.#ttl) || this.#ttl < 30 || this.#ttl > 900) throw new Error("request TTL must be 30 to 900 seconds");
    this.#clock = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid server clock");
    return now;
  }

  #identity(initData: string): TelegramIdentity {
    return verifyTelegramInitData(initData, this.#token, { nowSeconds: this.#now() });
  }

  /** Fixed operator origin and authenticated identity for the credential handoff adapter. */
  get applicationOrigin(): string { return this.#origin; }
  pairingIdentity(initData: string): TelegramIdentity { return this.#identity(initData); }
  pairingTime(): number { return this.#now(); }

  async #head(deployment: BotDeployment): Promise<number> {
    if (await this.#chain.getGenesisHash() !== deployment.genesisHash) throw new Error("RPC genesis does not match approved deployment");
    const slot = await this.#chain.getSlot("confirmed");
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("invalid chain slot");
    return slot;
  }

  async create(initData: string, input: CreateConsent): Promise<ConsentStatus> {
    const who = this.#identity(initData);
    if (!input || !/^[0-9a-f]{32,128}$/.test(input.requestKey)) throw new Error("invalid request key");
    const requestKey = input.requestKey;
    const appId = decimal(input.appId, FIELD_PRIME - 1n, "app id");
    if (appId === 0n) throw new Error("zero app id is reserved");
    const home = new PublicKey(input.home).toBase58();
    if (home !== input.home) throw new Error("invalid home");
    const expiry = decimal(input.sessionExpirySlot, U64_MAX, "session expiry");
    const slot = BigInt(await this.#head(this.#deployment));
    if (expiry <= slot || expiry > slot + this.#policy.sessionMaxSlots) throw new Error("session expiry exceeds approved policy");
    // Snapshot all mutable caller inputs before the store writes anything.
    const fields = { appOrigin: this.#origin, deployment: this.#deployment, appId: appId.toString(),
      home, policy: policyToDto(this.#policy), sessionExpirySlot: expiry.toString() };
    const fingerprint = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    const now = this.#now();
    return this.#store.create(who.botId, who.userId, requestKey, fingerprint, now, () => {
      const seed = randomBytes(32);
      const session = softwareSession(seed);
      return { seed, consent: { version: 1, id: randomBytes(32).toString("hex"), botId: who.botId, userId: who.userId,
        ...fields, pocket: toBase58(pocketPda(appId, new PublicKey(this.#deployment.pocketProgram).toBytes()).address),
        sessionKeyHex: bytesToHex(session.key32), createdAt: now, expiresAt: now + this.#ttl } };
    });
  }

  status(initData: string, id: string): ConsentStatus {
    const who = this.#identity(initData);
    return this.#store.read(id, who.botId, who.userId, this.#now());
  }

  /** Idempotent completion, based on current confirmed chain state, never a client signature string. */
  async confirm(initData: string, id: string): Promise<ConsentStatus> {
    const who = this.#identity(initData);
    const row = this.#store.read(id, who.botId, who.userId, this.#now());
    if (row.state !== "pending" && row.state !== "confirmed") throw new Error("consent request is no longer pending");
    const { slot } = await this.#checkActive(row);
    // Re-read under the transaction: cancellation or expiry during RPC wins.
    return this.#store.confirm(id, who.botId, who.userId, this.#now(), slot);
  }

  cancel(initData: string, id: string): ConsentStatus {
    const who = this.#identity(initData);
    return this.#store.cancel(id, who.botId, who.userId, this.#now());
  }

  async #checkActive(row: ConsentStatus) {
    const consent = row.consent;
    if (JSON.stringify(consent.deployment) !== JSON.stringify(this.#deployment) || consent.appOrigin !== this.#origin) {
      throw new Error("stored consent belongs to another configured application or deployment");
    }
    const slot = Math.max(await this.#head(consent.deployment), row.confirmedSlot ?? 0, row.observedSlot ?? 0,
      this.#store.authorizationSlot(consent));
    const response = await this.#chain.getAccountInfoAndContext(new PublicKey(consent.pocket), {
      commitment: "confirmed", minContextSlot: slot,
    });
    if (!Number.isSafeInteger(response.context.slot) || response.context.slot < slot) {
      throw new Error("confirmed pocket state is unavailable or stale");
    }
    this.#store.observeSlot(consent.id, consent.botId, consent.userId, this.#now(), response.context.slot);
    if (!response.value) throw new Error("confirmed pocket state is unavailable");
    const account = readPocketAccount(response.value, new PublicKey(consent.deployment.pocketProgram));
    const id = BigInt(consent.appId);
    const expectedPda = pocketPda(id, new PublicKey(consent.deployment.pocketProgram).toBytes());
    const key33 = new Uint8Array(33);
    key33.set(hexToBytes(consent.sessionKeyHex));
    if (toBase58(expectedPda.address) !== consent.pocket || account.bump !== expectedPda.bump ||
      !equal(account.appId, fieldToBytes32(id)) || !equal(account.domainHash, fieldToBytes32(domainHash(consent.appOrigin))) ||
      account.home.toBase58() !== consent.home || account.sessionKind !== 0 || !equal(account.sessionKey, key33) ||
      account.sessionExpirySlot !== BigInt(consent.sessionExpirySlot) || account.sessionExpirySlot <= BigInt(response.context.slot) ||
      !equal(policyHash(account.policy), policyHash(policyFromDto(consent.policy)))) {
      throw new Error("confirmed pocket does not match the approved bot permissions");
    }
    return { slot: response.context.slot, account };
  }

  /** Backend-only. One stable business request key always identifies one immutable trade. */
  async prepareIntent(id: string, who: Pick<TelegramIdentity, "botId" | "userId">,
    input: { requestKey: string; params: BotIntentParams }): Promise<SignedIntent> {
    if (!input || !/^[0-9a-f]{32,128}$/.test(input.requestKey)) throw new Error("invalid order request key");
    return this.#prepare(id, { ...who }, input.requestKey, copyParams(input.params));
  }

  /** Compatibility API: explicit nonces share the durable allocator and cannot move backwards. */
  async signIntent(id: string, who: Pick<TelegramIdentity, "botId" | "userId">, params: IntentParams): Promise<SignedIntent> {
    const intent = copyParams(params), nonce = params.nonce;
    if (typeof nonce !== "bigint" || nonce < 0n || nonce > U64_MAX) throw new Error("invalid explicit nonce");
    const row = this.#store.read(id, who.botId, who.userId, this.#now());
    const requestKey = "manual:" + digest(orderFingerprint(row.consent, intent, nonce));
    return this.#prepare(id, { ...who }, requestKey, intent, nonce);
  }

  orderStatus(id: string, who: Pick<TelegramIdentity, "botId" | "userId">, requestKey: string): BotOrderStatus {
    const { consent } = this.#store.read(id, who.botId, who.userId, this.#now());
    const order = this.#store.readOrder(consent, requestKey);
    if (!order) throw new Error("order not found");
    return orderStatus(order);
  }

  /** Prevents local release of an order; cannot recall a signature already returned. */
  cancelOrder(id: string, who: Pick<TelegramIdentity, "botId" | "userId">, requestKey: string): BotOrderStatus {
    const { consent } = this.#store.read(id, who.botId, who.userId, this.#now());
    return orderStatus(this.#store.cancelOrder(consent, requestKey));
  }

  async #prepare(id: string, who: Pick<TelegramIdentity, "botId" | "userId">, requestKey: string,
    intent: BotIntentParams, explicitNonce?: bigint): Promise<SignedIntent> {
    const row = this.#store.read(id, who.botId, who.userId, this.#now());
    if (row.state !== "confirmed") throw new Error("bot session is not active locally");
    const fingerprint = orderFingerprint(row.consent, intent, explicitNonce);
    const { slot, account } = await this.#checkActive(row);
    if (intent.deadlineSlot < BigInt(slot) || intent.deadlineSlot >= BigInt(row.consent.sessionExpirySlot)) {
      throw new Error("intent amount or deadline is outside the active session");
    }
    const order = this.#store.reserveOrder(row.consent, requestKey, fingerprint, intent, account, slot, this.#now(), explicitNonce);
    if (order.state === "signed") return signedOrder(order);
    const signed = await this.#store.withSeed(id, who.botId, who.userId, async seed => {
      const session = softwareSession(seed);
      if (bytesToHex(session.key32) !== row.consent.sessionKeyHex) throw new Error("stored bot key does not match consent");
      const pocket = derivePocket(BigInt(row.consent.appId), new PublicKey(row.consent.home).toBytes(), policyFromDto(row.consent.policy));
      pocket.address = new PublicKey(row.consent.pocket).toBytes();
      return signIntent(pocket, session, decodeIntent(order.intent));
    });
    // The durable write and local authorization check happen before releasing this bearer signature.
    return signedOrder(this.#store.saveSignedOrder(row.consent, requestKey, signed, slot, this.#now()));
  }
}
