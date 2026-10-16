import { createHmac, createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID, domainHash, fieldToBytes32, hexToBytes, pocketPda } from "@ghostlink/common";
import { policyFromDto } from "@ghostlink/sdk";
import { BorshWriter, POCKET_ACCOUNT_SIZE, writePolicy } from "@ghostlink/service-kit";
import type { BotConsent, BotDeployment } from "../src/index.js";

export const TOKEN = "12345:" + "a".repeat(32); // synthetic test token, no Telegram account
export const NOW = 1_800_000_000;
export const USER = { botId: "12345", userId: "42" };
export const deployment: BotDeployment = { cluster: "localnet", genesisHash: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
  pocketProgram: POCKET_PROGRAM_ID, registryProgram: REGISTRY_PROGRAM_ID, censusProgram: CENSUS_PROGRAM_ID };

export function initData(userId = 42, authDate = NOW, extra: Record<string, string> = {}, token = TOKEN) {
  const values = { auth_date: String(authDate), query_id: "test-query", user: JSON.stringify({ id: userId, first_name: "Fixture", is_bot: false }), ...extra };
  const check = Object.keys(values).sort().map(k => `${k}=${values[k as keyof typeof values]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...values, hash }).toString();
}

export function pocketAccount(c: BotConsent, nonceBase = 0n, used: bigint[] = []) {
  const key = new Uint8Array(33); key.set(hexToBytes(c.sessionKeyHex));
  const w = new BorshWriter().fixed(createHash("sha256").update("account:PocketV3").digest().subarray(0, 8))
    .fixed(fieldToBytes32(BigInt(c.appId))).fixed(fieldToBytes32(domainHash(c.appOrigin)))
    .fixed(new PublicKey(c.home).toBytes()).u8(0).fixed(key).u64(BigInt(c.sessionExpirySlot));
  writePolicy(w, policyFromDto(c.policy));
  const bitmap = new Uint8Array(256);
  for (const n of used) { const bit = Number(n % 2048n); bitmap[Math.floor(bit / 8)]! |= 1 << (bit % 8); }
  w.u8(0).u64(1n).u64(0n).fixed(bitmap)
    .u8(pocketPda(BigInt(c.appId), new PublicKey(c.deployment.pocketProgram).toBytes()).bump)
    .u64(BigInt(c.sessionExpirySlot)).u64(nonceBase).u64(0n);
  const data = Buffer.alloc(POCKET_ACCOUNT_SIZE); data.set(w.out());
  return { data, owner: new PublicKey(c.deployment.pocketProgram), executable: false, lamports: 1, rentEpoch: 0 };
}
