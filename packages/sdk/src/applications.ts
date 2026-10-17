import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import {
  bytesToHex, policyHash, CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID,
  type BotDeployment, type PolicyDto,
} from "@ghostlink/common";
import { policyFromDto, policyToDto } from "./ghostlink.js";

export interface TrustedApplication {
  id: string;
  name: string;
  /** Permanent identity namespace, unique per bot, including retired bots. */
  appOrigin: string;
  authorizationBaseUrl: string;
  telegramBotId: string;
  status: "enabled" | "disabled";
  policy: PolicyDto;
}

export interface ApplicationManifest {
  version: 1;
  revision: number;
  previousDigest?: string;
  ownerOrigin: string;
  deployment: BotDeployment;
  issuedAt: number;
  expiresAt: number;
  applications: TrustedApplication[];
}

/** Internal strict wire validators. Errors deliberately exclude submitted values. */
export function consentObject(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("invalid consent object");
  const v = value as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(v, k)) ||
    Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) throw new Error("invalid consent fields");
  return v;
}

export function canonicalConsentJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalConsentJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalConsentJson((value as any)[k])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("non-JSON consent value");
  return encoded;
}
export function consentDigest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalConsentJson(value))));
}
export function consentDecimal(value: unknown, max = (1n << 64n) - 1n): string {
  if (typeof value !== "string" || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > max) {
    throw new Error("invalid consent integer");
  }
  return value;
}
export function consentAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 44) throw new Error("invalid consent address");
  try {
    const bytes = bs58.decode(value);
    if (bytes.length === 32 && bs58.encode(bytes) === value) return value;
  } catch { /* Generic error below. */ }
  throw new Error("invalid consent address");
}
export function consentTime(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid consent time");
  return value as number;
}
function endpoint(value: unknown, origin: boolean, loopback: boolean): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("invalid application URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid application URL"); }
  const local = loopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash ||
    (origin ? value !== url.origin : value !== url.href || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(url.pathname))) {
    throw new Error("noncanonical application URL");
  }
  return value;
}

export function canonicalConsentPolicy(raw: unknown): PolicyDto {
  const p = consentObject(raw, ["dailyCapUsdE6", "maxSlippageBps", "bigActionThresholdUsdE6", "noOracleCapUsdE6",
    "sessionMaxSlots", "allowedOutMints", "oracleFeeds"], ["speculative"]);
  for (const k of ["dailyCapUsdE6", "bigActionThresholdUsdE6", "noOracleCapUsdE6", "sessionMaxSlots"]) consentDecimal(p[k]);
  if (BigInt(p.sessionMaxSlots) === 0n || !Number.isInteger(p.maxSlippageBps) || p.maxSlippageBps < 0 || p.maxSlippageBps > 10_000) {
    throw new Error("invalid consent policy limits");
  }
  if (!Array.isArray(p.allowedOutMints) || p.allowedOutMints.length > 8 || !Array.isArray(p.oracleFeeds) || p.oracleFeeds.length > 8) {
    throw new Error("invalid consent policy assets");
  }
  p.allowedOutMints.forEach(consentAddress);
  for (const f of p.oracleFeeds) {
    consentObject(f, ["mint", "feedIdHex", "decimals"]);
    consentAddress(f.mint);
    if (typeof f.feedIdHex !== "string" || !/^[0-9a-f]{64}$/.test(f.feedIdHex)) throw new Error("invalid oracle feed");
  }
  if (p.speculative !== undefined) {
    const s = consentObject(p.speculative, ["dailyBuyCapUsdE6", "maxCostExposureUsdE6", "maxPositions", "baseMints"]);
    consentDecimal(s.dailyBuyCapUsdE6); consentDecimal(s.maxCostExposureUsdE6);
    if (!Array.isArray(s.baseMints) || s.baseMints.length > 4) throw new Error("invalid speculative bases");
    s.baseMints.forEach(consentAddress);
  }
  const policy = policyFromDto(p as PolicyDto);
  policyHash(policy); // The identical policy encoder used by on-chain authorization.
  return JSON.parse(JSON.stringify(policyToDto(policy))) as PolicyDto;
}

export function canonicalBotDeployment(raw: unknown): BotDeployment {
  const d = consentObject(raw, ["cluster", "genesisHash", "pocketProgram", "registryProgram", "censusProgram"]);
  for (const k of ["genesisHash", "pocketProgram", "registryProgram", "censusProgram"]) consentAddress(d[k]);
  if (d.cluster !== "localnet" || d.pocketProgram !== POCKET_PROGRAM_ID || d.registryProgram !== REGISTRY_PROGRAM_ID ||
    d.censusProgram !== CENSUS_PROGRAM_ID || ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"].includes(d.genesisHash)) {
    throw new Error("no verified public-network owner deployment");
  }
  return { ...d } as BotDeployment;
}

function manifest(raw: unknown): ApplicationManifest {
  const m = consentObject(raw, ["version", "revision", "ownerOrigin", "deployment", "issuedAt", "expiresAt", "applications"], ["previousDigest"]);
  if (m.version !== 1 || !Number.isSafeInteger(m.revision) || m.revision < 1 ||
    (m.revision === 1 ? m.previousDigest !== undefined : typeof m.previousDigest !== "string" || !/^[0-9a-f]{64}$/.test(m.previousDigest))) {
    throw new Error("invalid application revision");
  }
  const ownerOrigin = endpoint(m.ownerOrigin, true, true);
  const issuedAt = consentTime(m.issuedAt), expiresAt = consentTime(m.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 604_800) throw new Error("application registry lifetime exceeds seven days");
  if (!Array.isArray(m.applications) || m.applications.length > 256) throw new Error("invalid application list");
  const ids = new Set(), origins = new Set(), bots = new Set();
  const applications = m.applications.map((rawApp: unknown): TrustedApplication => {
    const a = consentObject(rawApp, ["id", "name", "appOrigin", "authorizationBaseUrl", "telegramBotId", "status", "policy"]);
    if (typeof a.id !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(a.id) || typeof a.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,79}$/.test(a.name) || !["enabled", "disabled"].includes(a.status)) throw new Error("invalid application identity");
    const appOrigin = endpoint(a.appOrigin, true, false), authorizationBaseUrl = endpoint(a.authorizationBaseUrl, false, true);
    const telegramBotId = consentDecimal(a.telegramBotId, (1n << 52n) - 1n);
    if (telegramBotId === "0" || appOrigin === ownerOrigin || new URL(authorizationBaseUrl).origin === ownerOrigin ||
      ids.has(a.id) || origins.has(appOrigin) || bots.has(telegramBotId)) throw new Error("application namespaces must be unique and separate from the owner");
    ids.add(a.id); origins.add(appOrigin); bots.add(telegramBotId);
    return { id: a.id, name: a.name, appOrigin, authorizationBaseUrl, telegramBotId, status: a.status, policy: canonicalConsentPolicy(a.policy) };
  }).sort((a: TrustedApplication, b: TrustedApplication) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { version: 1, revision: m.revision, ...(m.previousDigest === undefined ? {} : { previousDigest: m.previousDigest }),
    ownerOrigin, deployment: canonicalBotDeployment(m.deployment), issuedAt, expiresAt, applications };
}

/** Publishing helper, NOT an endorsement. Pin its result in trusted owner configuration. */
export function applicationRegistryDigest(raw: unknown): string { return consentDigest(manifest(raw)); }

/** Operator-vetted registry. Never accept a digest or registry from a bot/link as its own trust anchor. */
export class ApplicationRegistry {
  #manifest: ApplicationManifest;
  #digest: string;
  constructor(raw: unknown, approvedDigest: string) {
    const parsed = manifest(raw), digest = consentDigest(parsed);
    if (!/^[0-9a-f]{64}$/.test(approvedDigest) || digest !== approvedDigest) throw new Error("unapproved application registry");
    this.#manifest = parsed;
    this.#digest = digest;
  }
  get digest(): string { return this.#digest; }
  snapshot(nowSeconds: number): ApplicationManifest {
    consentTime(nowSeconds);
    if (this.#manifest.issuedAt > nowSeconds + 30 || this.#manifest.expiresAt <= nowSeconds) throw new Error("application registry is not current");
    return structuredClone(this.#manifest);
  }
  application(id: string, nowSeconds: number): TrustedApplication {
    const a = this.snapshot(nowSeconds).applications.find(a => a.id === id);
    if (!a || a.status !== "enabled") throw new Error("application is not enabled");
    return a;
  }
  /** Keep disabled tombstones forever; origin/bot reassignment could inherit an owner's pocket. */
  update(raw: unknown, approvedDigest: string): void {
    const next = new ApplicationRegistry(raw, approvedDigest), m = next.#manifest, old = this.#manifest;
    if (m.revision !== old.revision + 1 || m.previousDigest !== this.#digest || m.ownerOrigin !== old.ownerOrigin ||
      consentDigest(m.deployment) !== consentDigest(old.deployment) || m.issuedAt < old.issuedAt) throw new Error("application registry continuity failed");
    for (const prior of old.applications) {
      const a = m.applications.find(a => a.id === prior.id);
      if (!a || a.appOrigin !== prior.appOrigin || a.telegramBotId !== prior.telegramBotId ||
        (prior.status === "disabled" && a.status !== "disabled")) throw new Error("application namespace cannot be reassigned or revived");
    }
    this.#manifest = m;
    this.#digest = next.#digest;
  }
}
