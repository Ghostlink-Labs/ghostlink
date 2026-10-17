// Actual Unix signals and disconnected HTTP, with a disposable payer and local synthetic RPC.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import { RelayerJournal } from "../dist/journal.js";

if (process.platform === "win32") throw new Error("Run this signal drill on Linux/WSL");
const dir = mkdtempSync(join(tmpdir(), "ghostlink-relayer-shutdown-"));
const key = randomBytes(32), payer = Keypair.generate(), genesisHash = Keypair.generate().publicKey.toBase58();
const scope = { genesisHash, payer: payer.publicKey.toBase58(), pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() };
let slot = 10, enter, release;
const entered = new Promise(resolve => { enter = resolve; }), blocked = new Promise(resolve => { release = resolve; });
const accepted = new Set();
const rpc = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const call = JSON.parse(body);
  let result;
  if (call.method === "getGenesisHash") result = genesisHash;
  else if (call.method === "getBalance") result = { context: { slot: ++slot }, value: 1_000_000_000 };
  else if (call.method === "getLatestBlockhash") {
    enter(); await blocked;
    result = { context: { slot }, value: { blockhash: genesisHash, lastValidBlockHeight: 1000 } };
  } else if (call.method === "getFeeForMessage") result = { context: { slot }, value: 10000 };
  else if (call.method === "getBlockHeight") result = slot;
  else if (call.method === "getSignatureStatuses") result = { context: { slot }, value: call.params[0].map(id => accepted.has(id)
    ? { slot, confirmations: 1, err: null, confirmationStatus: "confirmed" } : null) };
  else if (call.method === "sendTransaction") {
    result = bs58.encode(Transaction.from(Buffer.from(call.params[0], "base64")).signature); accepted.add(result);
  } else { res.writeHead(500); res.end("unexpected synthetic RPC"); return; }
  res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
});
async function listen(server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port;
}
async function unusedPort() {
  const probe = createServer(), port = await listen(probe);
  await new Promise(resolve => probe.close(resolve)); return port;
}
let child, outcome, client;
try {
  const rpcPort = await listen(rpc), port = await unusedPort();
  let operationsPort = await unusedPort(); while (operationsPort === port) operationsPort = await unusedPort();
  const keyFile = join(dir, "storage.key"), signerFile = join(dir, "payer.json"), journalFile = join(dir, "journal.sqlite");
  writeFileSync(keyFile, key, { mode: 0o600 }); writeFileSync(signerFile, JSON.stringify([...payer.secretKey]), { mode: 0o600 });
  const initialized = new RelayerJournal(journalFile, key, scope), journalId = initialized.instanceId;
  initialized.close();
  let output = "";
  child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), OPERATIONS_PORT: String(operationsPort), RPC_URL: `http://127.0.0.1:${rpcPort}`,
      RPC_ENDPOINTS_PATH: "", RELAYER_GENESIS_HASH: genesisHash, GHOSTLINK_RELAYER_KEYPAIR: signerFile,
      RELAYER_MIN_BALANCE_LAMPORTS: "50000000", RELAYER_DAILY_BUDGET_LAMPORTS: "1000000", RELAYER_BUDGET_PATH: "",
      RELAYER_JOURNAL_PATH: journalFile, RELAYER_JOURNAL_KEY_PATH: keyFile, RELAYER_JOURNAL_ID: journalId }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-8192); });
  outcome = once(child, "exit");
  const base = `http://127.0.0.1:${port}`, deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("relayer exited before readiness: " + output);
    try { ready = (await fetch(`${base}/ready`)).status === 200; } catch {}
    if (ready) break; await delay(100);
  }
  assert.ok(ready, "relayer did not become ready");
  const requestIdHex = randomBytes(32).toString("hex"), body = JSON.stringify({ requestIdHex,
    wallet: Keypair.generate().publicKey.toBase58(), holding: payer.publicKey.toBase58() });
  client = request(`${base}/snapshot`, { method: "POST" }, res => res.resume());
  client.on("error", () => {}); client.end(body);
  await Promise.race([entered, delay(5000, undefined, { ref: false }).then(() => { throw new Error("request never reached delayed RPC"); })]);
  child.kill("SIGTERM"); client.destroy(); await delay(250);
  assert.equal(child.exitCode, null, "shutdown retired the journal while disconnected work remained");
  assert.equal(child.signalCode, null);
  const metrics = await (await fetch(`http://127.0.0.1:${operationsPort}/metrics`)).text();
  assert(metrics.includes("ghostlink_relayer_ready 0")); assert(metrics.includes("ghostlink_relayer_active 1"));
  release();
  const [code, signal] = await Promise.race([outcome, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("graceful shutdown timed out"); })]);
  assert.equal(signal, null); assert.equal(code, 0, output);
  const reopened = new RelayerJournal(journalFile, key, scope);
  try {
    reopened.checkWritable(); assert.equal(reopened.spent(), 10000n);
    assert.equal(reopened.get(requestIdHex).observation.state, "confirmed");
    assert(accepted.has(reopened.get(requestIdHex).packet.signature)); assert.equal(accepted.size, 1);
  } finally { reopened.close(); }
  console.log("Relayer SIGTERM drill passed: disconnected paid work completed once before journal close; encrypted receipt reopened.");
} finally {
  release(); client?.destroy();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await outcome; }
  rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve));
  key.fill(0); rmSync(dir, { recursive: true, force: true });
}
