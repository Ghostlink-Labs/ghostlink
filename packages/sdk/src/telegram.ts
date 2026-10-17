import { hexToBytes } from "@ghostlink/common";
import { verifyTelegramSignatureWithKey } from "./telegram-signature.js";

export interface TelegramOwnerIdentity { readonly botId: string; readonly userId: string; readonly authDate: number }

/**
 * Authenticate Telegram initData in the trusted owner app without a bot token.
 * expectedBotId comes from the pinned application registry, never the launch URL.
 * Keep raw initData in memory and send it only to that bot's registered backend.
 * https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
 */
export function verifyTelegramOwnerInitData(raw: string, expectedBotId: string, options: {
  nowSeconds?: number;
  /** Trusted owner configuration only; never take this from a partner request. */
  environment?: "production" | "test";
} = {}): TelegramOwnerIdentity {
  const environment = options.environment ?? "production";
  if (environment !== "production" && environment !== "test") throw new Error("invalid Telegram environment");
  const key = environment === "production"
    ? "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d"
    : "40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec";
  return verifyTelegramSignatureWithKey(raw, expectedBotId, hexToBytes(key), options.nowSeconds ?? Math.floor(Date.now() / 1000));
}
