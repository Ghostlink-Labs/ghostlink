import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { parseTelegramPairingCode, prepareTelegramPairing, verifyTelegramPairingClaim } from "../src/pairing.js";
import { verifyTelegramOwnerInitData } from "../src/telegram.js";
// Boundary composition test. Real signature verification/refusal is covered in telegram-owner.test.ts.
vi.mock("../src/telegram.js",()=>({verifyTelegramOwnerInitData:vi.fn(()=>({botId:"12345",userId:"42",authDate:100}))}));
it("uses fresh 256-bit codes and rejects bot/user/expiry/schema substitution before releasing initData",()=>{
 const first=prepareTelegramPairing("signed","12345"),second=prepareTelegramPairing("signed","12345");
 expect(first.code).not.toBe(second.code);const parsed=parseTelegramPairingCode(first.code);
 expect(parsed.tokenHash).toBe(createHash("sha256").update(Buffer.from(parsed.token,"hex")).digest("hex"));
 const response={initData:"signed",expiresAt:200};expect(verifyTelegramPairingClaim(first.code,"12345",response,100).identity.userId).toBe("42");
 for(const code of [first.code+" ",first.code.replace(".42.",".043."),first.code.replace(".42.",".4503599627370496."),"GLP1.12345.42.short"])expect(()=>parseTelegramPairingCode(code)).toThrow();
 expect(()=>verifyTelegramPairingClaim(first.code,"54321",response,100)).toThrow();
 expect(()=>verifyTelegramPairingClaim(first.code.replace(".42.",".43."),"12345",response,100)).toThrow(/user mismatch/);
 for(const changed of [{...response,expiresAt:100},{...response,expiresAt:221},{...response,returnUrl:"https://evil.example"}])expect(()=>verifyTelegramPairingClaim(first.code,"12345",changed,100)).toThrow();
 vi.mocked(verifyTelegramOwnerInitData).mockImplementationOnce(()=>{throw new Error("bad Telegram signature");});
 expect(()=>verifyTelegramPairingClaim(first.code,"12345",response,100)).toThrow(/signature/);
});
