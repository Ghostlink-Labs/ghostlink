import { describe, expect, it } from "vitest";
import { verifyTelegramInitData } from "../src/index.js";
import { initData, NOW, TOKEN } from "./helpers.js";

describe("Telegram authentication", () => {
  it("validates the HMAC including the optional signature field and returns only stable identity", () => {
    const raw = initData(42, NOW, { signature: "test-third-party-signature", start_param: "consent" });
    expect(verifyTelegramInitData(raw, TOKEN, { nowSeconds: NOW })).toEqual({ botId: "12345", userId: "42", authDate: NOW });
    expect(() => verifyTelegramInitData(raw.replace("test-third-party-signature", "changed"), TOKEN, { nowSeconds: NOW })).toThrow();
  });

  it("refuses cross-bot, tampered, stale/future, duplicate and malformed launch data", () => {
    const raw = initData();
    for (const bad of [raw.replace("Fixture", "Attacker"), initData(42, NOW - 301), initData(42, NOW + 31),
      raw + "&auth_date=" + NOW, raw + "&%75ser=%7B%22id%22%3A99%7D", raw + "&x=%zz", raw + "&x=%FF",
      initData(42, NOW, { user: '{"id":9007199254740992}' }), initData(42, NOW, { user: '{"id":42,"is_bot":true}' }),
      initData(42, NOW, { query_id: "one\nauth_date=2" }), "x=" + "a".repeat(16_384),
    ]) expect(() => verifyTelegramInitData(bad, TOKEN, { nowSeconds: NOW })).toThrow();
    expect(() => verifyTelegramInitData(raw, "54321:" + "b".repeat(32), { nowSeconds: NOW })).toThrow();
    expect(() => verifyTelegramInitData(raw, TOKEN, { nowSeconds: NOW, maxAgeSeconds: Number.NaN })).toThrow();
  });
});
