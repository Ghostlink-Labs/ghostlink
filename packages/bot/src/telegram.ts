import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramIdentity { botId: string; userId: string; authDate: number }

/** Server-side only. Never accept initDataUnsafe or a browser-supplied user ID. */
export function verifyTelegramInitData(
  raw: string,
  botToken: string,
  options: { nowSeconds?: number; maxAgeSeconds?: number; futureSkewSeconds?: number } = {},
): TelegramIdentity {
  const token = /^([1-9][0-9]*):[A-Za-z0-9_-]{20,}$/.exec(botToken);
  if (!token) throw new Error("invalid bot token configuration");
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const age = options.maxAgeSeconds ?? 300;
  const skew = options.futureSkewSeconds ?? 30;
  if (![now, age, skew].every(Number.isSafeInteger) || now < 0 || age < 1 || age > 3600 || skew < 0 || skew > 60) {
    throw new Error("invalid Telegram authentication time policy");
  }
  const invalid = () => new Error("invalid or expired Telegram authentication");
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 16_384 || /%(?![0-9a-f]{2})/i.test(raw)) throw invalid();
  const data = new URLSearchParams(raw);
  const seen = new Set<string>();
  for (const [key, value] of data) {
    if (seen.has(key) || !/^[a-z_][a-z0-9_]{0,63}$/.test(key) || /[\r\n\uFFFD]/.test(value)) throw invalid();
    seen.add(key);
  }
  const hash = data.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw invalid();
  data.delete("hash");
  // HMAC includes every remaining field, including Telegram's optional
  // third-party `signature` field. Its Ed25519 scheme has different rules.
  const check = [...data].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  secret.fill(0);
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw invalid();
  const date = data.get("auth_date");
  if (!date || !/^(0|[1-9][0-9]{0,15})$/.test(date)) throw invalid();
  const authDate = Number(date);
  if (!Number.isSafeInteger(authDate) || authDate > now + skew || now - authDate > age) throw invalid();
  let user: unknown;
  try { user = JSON.parse(data.get("user") ?? "null"); } catch { throw invalid(); }
  if (!user || typeof user !== "object" || !("id" in user) || !Number.isSafeInteger(user.id) || Number(user.id) < 1 ||
    ("is_bot" in user && user.is_bot !== false)) throw invalid();
  return { botId: token[1]!, userId: String(user.id), authDate };
}
