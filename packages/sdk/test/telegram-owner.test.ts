import { expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { verifyTelegramOwnerInitData } from "../src/index.js";
import { verifyTelegramSignatureWithKey } from "../src/telegram-signature.js";

// Synthetic signatures exercise the real algorithm; they are NOT Telegram-issued acceptance evidence.
const seed = new Uint8Array(32).fill(19), key = ed25519.getPublicKey(seed), botId = "123456", now = 1_700_000_000;
function signed(fields: Record<string, string> = {}, forBot = botId) {
  const data = new URLSearchParams({ auth_date: String(now), query_id: "fixture-query", user: JSON.stringify({ id: 9876543210, first_name: "Test" }), ...fields });
  const check = [...data].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("\n");
  data.set("signature", Buffer.from(ed25519.sign(new TextEncoder().encode(`${forBot}:WebAppData\n${check}`), seed)).toString("base64url"));
  data.set("hash", "ab".repeat(32));
  return data;
}
it("verifies the complete Telegram third-party transcript and excludes hash without exposing a custom production key", () => {
  const data = signed();
  expect(verifyTelegramSignatureWithKey(data.toString(), botId, key, now)).toEqual({ botId, userId: "9876543210", authDate: now });
  data.set("hash", "cd".repeat(32));
  data.set("signature", data.get("signature")! + "==");
  expect(verifyTelegramSignatureWithKey(data.toString(), botId, key, now).userId).toBe("9876543210");
  for (const environment of ["production", "test"] as const) {
    expect(() => verifyTelegramOwnerInitData(data.toString(), botId, { nowSeconds: now, environment })).toThrow();
  }
  expect(() => verifyTelegramSignatureWithKey(data.toString(), "123457", key, now)).toThrow();
  data.set("user", JSON.stringify({ id: 1 }));
  expect(() => verifyTelegramSignatureWithKey(data.toString(), botId, key, now)).toThrow();
});
it("rejects expired, ambiguous, malformed and non-human launch credentials", () => {
  const verify = (raw: string) => verifyTelegramSignatureWithKey(raw, botId, key, now);
  for (const fields of [
    { auth_date: String(now - 301) }, { auth_date: String(now + 31) }, { auth_date: "01700000000" },
    { user: JSON.stringify({ id: 2 ** 52 }) }, { user: JSON.stringify({ id: 10, is_bot: true }) },
    { query_id: "line\nuser=forged" },
  ]) expect(() => verify(signed(fields).toString())).toThrow();
  const raw = signed().toString();
  for (const malformed of [raw + "&user=%7B%7D", raw + "&x=%FF", raw + "&x=%", raw + "&x=" + "x".repeat(16_384)]) {
    expect(() => verify(malformed)).toThrow();
  }
  const data = signed();
  data.delete("signature"); expect(() => verify(data.toString())).toThrow();
  data.set("signature", "A".repeat(85) + "B"); expect(() => verify(data.toString())).toThrow();
});
