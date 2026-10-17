import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { parseTelegramPairingCode } from "@ghostlink/sdk";
import type { TelegramIdentity } from "./telegram.js";

interface Entry {
  who: TelegramIdentity; authHash: string; encrypted: Buffer; iv: Buffer; tag: Buffer;
  expiresAt: number; retainUntil: number; claimHash?: string; consentId?: string; requestHash?: string;
}
export interface PairingReference { tokenHash: string; claimId: string }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Ephemeral credential handoff only; restarting cancels codes, never durable consent or on-chain authority. */
export class BotPairings {
  #entries = new Map<string,Entry>(); #key = randomBytes(32); #last = 0; #closed = false;
  #authenticate: (initData: string) => TelegramIdentity; #clock: () => number;
  #timer: ReturnType<typeof setInterval>;
  constructor(authenticate: (initData: string) => TelegramIdentity, clock = () => Math.floor(Date.now()/1000)) {
    this.#authenticate = authenticate; this.#clock = clock;
    this.#timer = setInterval(()=>{ try { this.#prune(this.#now()); } catch { this.close(); } },1000); this.#timer.unref();
  }
  #now() { const now=this.#clock(); if(this.#closed || !Number.isSafeInteger(now) || now<this.#last)throw new Error("pairing unavailable");this.#last=now;return now; }
  #prune(now:number) {
    for(const [key,e] of this.#entries) {
      if(now>=e.expiresAt) e.encrypted.fill(0);
      if(now >= (e.claimHash ? e.retainUntil : e.expiresAt)) { e.encrypted.fill(0); this.#entries.delete(key); }
    }
  }
  create(initData:string, tokenHash:string) {
    const now=this.#now();this.#prune(now);
    if(!hex(tokenHash))throw new Error("invalid pairing digest");
    const who=this.#authenticate(initData), authHash=hash(initData);
    // The owner independently verifies this signature; reject obviously unusable launches early.
    if(!new URLSearchParams(initData).has("signature"))throw new Error("Telegram third-party signature required");
    let entry=this.#entries.get(tokenHash);
    if(entry) {
      if(entry.authHash!==authHash || entry.expiresAt<=now)throw new Error("pairing cannot be rebound");
    } else {
      if(this.#entries.size>=256 || [...this.#entries.values()].filter(e=>e.who.botId===who.botId&&e.who.userId===who.userId).length>=3)throw new Error("pairing capacity reached");
      const expiresAt=Math.min(now+120,who.authDate+300);if(expiresAt<=now)throw new Error("pairing authentication expired");
      const iv=randomBytes(12), cipher=createCipheriv("aes-256-gcm",this.#key,iv);
      cipher.setAAD(Buffer.from(tokenHash));
      const clear=Buffer.from(initData);let encrypted:Buffer;
      try { encrypted=Buffer.concat([cipher.update(clear),cipher.final()]); } finally { clear.fill(0); }
      entry={who,authHash,encrypted,iv,tag:cipher.getAuthTag(),expiresAt,retainUntil:Math.min(who.authDate+300,now+300)};this.#entries.set(tokenHash,entry);
    }
    return {botId:who.botId,userId:who.userId,expiresAt:entry.expiresAt};
  }
  claim(code:string,claimId:string) {
    const now=this.#now();this.#prune(now);const parsed=parseTelegramPairingCode(code);
    const e=this.#entries.get(parsed.tokenHash);
    if(!hex(claimId)||!e||e.expiresAt<=now||e.who.botId!==parsed.botId||e.who.userId!==parsed.userId)throw new Error("pairing unavailable");
    const claimHash=hash(claimId);if(e.claimHash&&e.claimHash!==claimHash)throw new Error("pairing already claimed");
    const decipher=createDecipheriv("aes-256-gcm",this.#key,e.iv);decipher.setAAD(Buffer.from(parsed.tokenHash));decipher.setAuthTag(e.tag);
    const clear=Buffer.concat([decipher.update(e.encrypted),decipher.final()]);
    try { const initData=clear.toString("utf8");this.#authenticate(initData);e.claimHash=claimHash;return {initData,expiresAt:e.expiresAt}; } finally {clear.fill(0);}
  }
  authorizeReference(raw:unknown,initData:string,request?:{requestKey:string;appId:string;home:string;sessionExpirySlot:string}):PairingReference {
    this.#prune(this.#now());
    if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).sort().join(",")!=="claimId,tokenHash")throw new Error("invalid pairing reference");
    const r=raw as PairingReference,e=this.#entries.get(r.tokenHash);
    if(!hex(r.tokenHash)||!hex(r.claimId)||!e||e.claimHash!==hash(r.claimId)||e.authHash!==hash(initData))throw new Error("pairing reference refused");
    if(request) {
      const fingerprint=hash(JSON.stringify([request.requestKey,request.appId,request.home,request.sessionExpirySlot]));
      if(e.requestHash&&e.requestHash!==fingerprint)throw new Error("pairing request cannot be replaced");e.requestHash=fingerprint;
    }
    return {...r};
  }
  link(reference:PairingReference,initData:string,consentId:string) {
    this.authorizeReference(reference,initData);const e=this.#entries.get(reference.tokenHash)!;
    if(!hex(consentId)||(e.consentId&&e.consentId!==consentId))throw new Error("pairing already linked");e.consentId=consentId;
  }
  status(initData:string,tokenHash:string) {
    this.#prune(this.#now());const who=this.#authenticate(initData),e=this.#entries.get(tokenHash);
    if(!hex(tokenHash)||!e||who.botId!==e.who.botId||who.userId!==e.who.userId)throw new Error("pairing unavailable");
    return {state:e.consentId?"linked":e.claimHash?"claimed":"waiting",consentId:e.consentId};
  }
  close(){if(this.#closed)return;this.#closed=true;clearInterval(this.#timer);this.#key.fill(0);for(const e of this.#entries.values())e.encrypted.fill(0);this.#entries.clear();}
}
