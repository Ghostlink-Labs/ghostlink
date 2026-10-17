/** Real Unix shutdown during a receiver acknowledgment, followed by hosted restart. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { POCKET, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import { WatcherState } from "../dist/state.js";
if (process.platform === "win32") throw new Error("This drill requires real Unix signal delivery");
const dir = mkdtempSync(join(tmpdir(), "watcher-drain-")), key = randomBytes(32), genesisHash = Keypair.generate().publicKey.toBase58();
const keyPath = join(dir, "state.key"), path = join(dir, "watcher.db"), signature = bs58.encode(new Uint8Array(64).fill(7));
writeFileSync(keyPath, key);
const after = Buffer.alloc(8); after.writeBigUInt64LE(100n);
const logs = frameAsProgramLogs(POCKET.toBase58(), ["Program data: " + Buffer.concat([eventDisc("ChangeProposed"), Keypair.generate().publicKey.toBuffer(), after]).toString("base64")]);
const children = []; let held, transactionReads = 0, deliveries = 0;
const receiver = createServer(async (req, res) => { for await (const _ of req) { /* Drain the bounded fixture request. */ } deliveries++; held = () => { res.writeHead(200); res.end(); }; });
const provider = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const call = JSON.parse(raw), reply = result => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result })); };
  if (call.method === "getGenesisHash") return reply(genesisHash);
  if (call.method === "getSlot") return reply(10);
  if (call.method === "getSignaturesForAddress") return reply([{ signature, slot: 10, err: null, memo: null, blockTime: null, confirmationStatus: "confirmed" }]);
  if (call.method === "getTransaction") {
    transactionReads++;
    return reply({ slot: 10, blockTime: null, version: "legacy", meta: { err: null, fee: 0, preBalances: [], postBalances: [], logMessages: logs },
      transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, accountKeys: [POCKET.toBase58()], recentBlockhash: genesisHash, instructions: [] } } });
  }
  res.writeHead(500); res.end("unexpected synthetic method");
});
async function until(work, message) { const end = Date.now() + 10_000; while (Date.now() < end) { if (await work()) return; await delay(30); } throw new Error(message); }
async function start(rpcUrl, receiverUrl) {
  const port = createServer(); port.listen(0, "127.0.0.1"); await once(port, "listening"); const n = port.address().port; await new Promise(resolve => port.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], { env: { ...process.env,
    WATCHER_PORT: String(n), RPC_URL: rpcUrl, RPC_ENDPOINTS_PATH: "", WATCHER_GENESIS_HASH: genesisHash, WATCHER_STATE_PATH: path,
    WATCHER_STATE_KEY_PATH: keyPath, WATCHER_POLL_MS: "100", LARGE_FILL_USD_E6: "1", GHOSTLINK_WATCHER_KEYPAIR: "", NOTIFY_WEBHOOK: receiverUrl }, stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, output: "", url: `http://127.0.0.1:${n}` }; children.push(state);
  child.stdout.on("data", b => state.output += b); child.stderr.on("data", b => state.output += b); return state;
}
try {
  receiver.listen(0, "127.0.0.1"); provider.listen(0, "127.0.0.1"); await Promise.all([once(receiver, "listening"), once(provider, "listening")]);
  const rpcUrl = `http://127.0.0.1:${provider.address().port}`, receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
  const first = await start(rpcUrl, receiverUrl); await until(() => Boolean(held), "watcher did not reach held receiver acknowledgment");
  first.child.kill("SIGTERM"); await delay(150); assert.equal(first.child.exitCode, null, "watcher exited before active delivery drained");
  held(); await until(() => first.child.exitCode !== null, "watcher did not finish draining"); assert.equal(first.child.exitCode, 0, first.output);
  const db = new WatcherState(path, key, { genesisHash, pocketProgram: POCKET.toBase58(), payer: null,
    receiver: createHash("sha256").update(receiverUrl).digest("hex"), threshold: "1" });
  assert.equal(db.snapshot().cursor, signature); assert.equal(db.count(), 0); assert.equal(db.delivery(), undefined); db.close();
  const restarted = await start(rpcUrl, receiverUrl);
  await until(async () => { try { return (await fetch(`${restarted.url}/ready`)).status === 200; } catch { return false; } }, "restarted watcher never became ready");
  assert.equal(transactionReads, 1); assert.equal(deliveries, 1, "restart redelivered an acknowledged alert"); restarted.child.kill("SIGTERM");
  await until(() => restarted.child.exitCode !== null, "restarted watcher did not stop"); assert.equal(restarted.child.exitCode, 0, restarted.output);
  console.log("Watcher drain drill passed: active delivery acknowledged, checkpoint committed, ownership released and restart did not replay.");
} finally {
  for (const { child } of children) if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
  receiver.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => provider.close(resolve)), new Promise(resolve => receiver.close(resolve))]);
  key.fill(0); rmSync(dir, { recursive: true, force: true });
}
