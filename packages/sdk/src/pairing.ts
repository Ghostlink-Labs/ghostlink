import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@ghostlink/common";
import { verifyTelegramOwnerInitData } from "./telegram.js";

export interface TelegramPairingCode { botId: string; userId: string; token: string; tokenHash: string }
/** The code is a short-lived credential: copy/paste only, never URLs, logs or storage. */
export function parseTelegramPairingCode(code: string): TelegramPairingCode {
  if (typeof code !== "string" || code.length > 128) throw new Error("invalid pairing code");
  const match = /^GLP1\.([1-9][0-9]{0,15})\.([1-9][0-9]{0,15})\.([0-9a-f]{64})$/.exec(code);
  if (!match || ![match[1],match[2]].every(v => BigInt(v!) < 2n ** 52n)) throw new Error("invalid pairing code");
  return { botId: match[1]!, userId: match[2]!, token: match[3]!, tokenHash: bytesToHex(sha256(hexToBytes(match[3]!))) };
}
/** Run in the bot Mini App. Publish only tokenHash to its authenticated pairing endpoint. */
export function prepareTelegramPairing(initData: string, expectedBotId: string) {
  const who = verifyTelegramOwnerInitData(initData, expectedBotId);
  const token = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const code = `GLP1.${who.botId}.${who.userId}.${token}`;
  return { code, tokenHash: parseTelegramPairingCode(code).tokenHash, botId: who.botId, userId: who.userId };
}
/** Run only in the trusted owner app. A successful backend response is not Telegram authentication. */
export function verifyTelegramPairingClaim(code: string, expectedBotId: string, raw: unknown, nowSeconds = Math.floor(Date.now()/1000)) {
  const parsed = parseTelegramPairingCode(code);
  if (parsed.botId !== expectedBotId || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid pairing response");
  const response = raw as Record<string,unknown>;
  if (Object.keys(response).sort().join(",") !== "expiresAt,initData" || typeof response.initData !== "string" ||
    !Number.isSafeInteger(response.expiresAt) || Number(response.expiresAt) <= nowSeconds || Number(response.expiresAt) > nowSeconds + 120) throw new Error("invalid pairing response");
  const identity = verifyTelegramOwnerInitData(response.initData, expectedBotId, { nowSeconds });
  if (identity.userId !== parsed.userId) throw new Error("pairing Telegram user mismatch");
  return { identity, initData: response.initData, expiresAt: Number(response.expiresAt) };
}
