import { ed25519 } from "@noble/curves/ed25519";

/** Internal implementation, not exported by the SDK. Public API pins Telegram's keys. */
export function verifyTelegramSignatureWithKey(raw: string, botId: string, publicKey: Uint8Array, now: number) {
  const invalid = () => new Error("invalid or expired Telegram signature");
  if (typeof botId !== "string" || !/^[1-9][0-9]{0,15}$/.test(botId) || BigInt(botId) >= 1n << 52n ||
    !Number.isSafeInteger(now) || now < 0 || typeof raw !== "string" || new TextEncoder().encode(raw).length > 16_384 ||
    /%(?![0-9a-f]{2})/i.test(raw)) throw invalid();
  const data = new URLSearchParams(raw), seen = new Set<string>();
  for (const [key, value] of data) {
    if (seen.has(key) || !/^[a-z_][a-z0-9_]{0,63}$/.test(key) || /[\r\n\uFFFD]/.test(value)) throw invalid();
    seen.add(key);
  }
  const encoded = data.get("signature"), date = data.get("auth_date");
  if (!encoded || !/^[A-Za-z0-9_-]{86}(?:==)?$/.test(encoded) || !date || !/^(0|[1-9][0-9]{0,15})$/.test(date)) throw invalid();
  const authDate = Number(date);
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 300) throw invalid();
  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (signature.length !== 64 || canonical !== encoded.replace(/=+$/, "")) throw invalid();
  } catch { throw invalid(); }
  // The third-party scheme excludes BOTH fields; the bot server's HMAC scheme only excludes hash.
  data.delete("hash"); data.delete("signature");
  const check = [...data].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("\n");
  const message = new TextEncoder().encode(`${botId}:WebAppData\n${check}`);
  try { if (!ed25519.verify(signature, message, publicKey, { zip215: false })) throw invalid(); } catch { throw invalid(); }
  let user: any;
  try { user = JSON.parse(data.get("user") ?? "null"); } catch { throw invalid(); }
  if (!user || typeof user !== "object" || Array.isArray(user) || !Number.isSafeInteger(user.id) || user.id < 1 || user.id >= 2 ** 52 ||
    (user.is_bot !== undefined && user.is_bot !== false)) throw invalid();
  return Object.freeze({ botId, userId: String(user.id), authDate });
}
