/** Local-validator fixture: synthetic Telegram authentication, real HTTP and encrypted storage. */
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Connection } from "@solana/web3.js";
import { bytesToHex, CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID, toBase58, type Policy } from "@ghostlink/common";
import { BotKeyStore, BotOnboarding, createBotAuthorizationServer, type BotConsent, type ConsentStatus, type CreateConsent } from "@ghostlink/bot";
import type { IntentParams } from "@ghostlink/sdk";

// Deliberately synthetic, never used to contact Telegram.
const TOKEN = "12345:" + "a".repeat(32);
const ownerOrigin = "https://owner.example.com";
function initData() {
  const data = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 42, first_name: "Fixture" }) });
  const check = [...data].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  data.set("hash", createHmac("sha256", key).update(check).digest("hex"));
  return data.toString();
}

export async function startBotFixture(connection: Connection, appOrigin: string, policy: Policy) {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-bot-e2e-"));
  const key = randomBytes(32);
  const path = join(dir, "bot.sqlite");
  let store = new BotKeyStore(path, key);
  const options = { botToken: TOKEN, chain: connection, appOrigin, policy,
    deployment: { cluster: "localnet" as const, genesisHash: await connection.getGenesisHash(),
      pocketProgram: POCKET_PROGRAM_ID, registryProgram: REGISTRY_PROGRAM_ID, censusProgram: CENSUS_PROGRAM_ID } };
  let manager = new BotOnboarding({ ...options, store });
  let server = createBotAuthorizationServer(manager, ownerOrigin);
  let url = "";
  const listen = async () => {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("bot HTTP not listening");
    url = `http://127.0.0.1:${addr.port}`;
  };
  const stop = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const post = async (route: string, body: object): Promise<ConsentStatus> => {
    const response = await fetch(url + route, { method: "POST",
      headers: { origin: ownerOrigin, authorization: "tma " + initData(), "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`bot consent ${route}: ${response.status}`);
    return response.json() as Promise<ConsentStatus>;
  };
  await listen();
  return {
    create: (input: CreateConsent) => post("/requests", input),
    confirm: (id: string) => post(`/requests/${id}/confirm`, {}),
    async restart() {
      await stop(); store.close();
      store = new BotKeyStore(path, key);
      manager = new BotOnboarding({ ...options, store });
      server = createBotAuthorizationServer(manager, ownerOrigin);
      await listen();
    },
    async fill(consent: BotConsent, solverUrl: string, params: IntentParams): Promise<{ signature: string }> {
      const signed = await manager.signIntent(consent.id, { botId: "12345", userId: "42" }, params);
      const i = signed.intent;
      const response = await fetch(`${solverUrl}/intent`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pocket: consent.pocket, nonce: i.nonce.toString(), inMint: toBase58(i.inMint), inMax: i.inMax.toString(),
          outMint: toBase58(i.outMint), outMin: i.outMin.toString(), deadlineSlot: i.deadlineSlot.toString(), policyHashHex: bytesToHex(i.policyHash),
          sessionKind: 0, signatureHex: bytesToHex(signed.signature.signature), sessionKeyHex: consent.sessionKeyHex }) });
      if (!response.ok) throw new Error(`bot fill: ${await response.text()}`);
      return response.json() as Promise<{ signature: string }>;
    },
    async close() { await stop(); store.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); },
  };
}
