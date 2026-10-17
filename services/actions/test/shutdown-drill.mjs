// Real Unix signals and disconnected HTTP against a disposable synthetic RPC. No wallet signs or sends.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Keypair } from "@solana/web3.js";
import { POCKET, POCKET_ACCOUNT_SIZE } from "@ghostlink/service-kit";

if (process.platform === "win32") throw new Error("Run this signal drill on Linux/WSL");
const genesisHash = Keypair.generate().publicKey.toBase58(), user = Keypair.generate().publicKey;
const appIdHex = "01".repeat(32), pocketData = Buffer.alloc(POCKET_ACCOUNT_SIZE);
createHash("sha256").update("account:PocketV3").digest().copy(pocketData, 0, 0, 8);
Buffer.from(appIdHex, "hex").copy(pocketData, 8); user.toBuffer().copy(pocketData, 72);
let slot = 10, blocks = 0, enter, release;
const entered = new Promise(resolve => { enter = resolve; }), blocked = new Promise(resolve => { release = resolve; });
const rpc = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const call = JSON.parse(body);
  let result;
  if (call.method === "getGenesisHash") result = genesisHash;
  else if (call.method === "getSlot") result = ++slot;
  else if (call.method === "getMultipleAccounts") {
    enter(); await blocked;
    result = { context: { slot }, value: [{ owner: POCKET.toBase58(), executable: false, lamports: 1,
      rentEpoch: 0, data: [pocketData.toString("base64"), "base64"] }] };
  } else if (call.method === "getLatestBlockhash") {
    blocks++; result = { context: { slot }, value: { blockhash: genesisHash, lastValidBlockHeight: 1000 } };
  } else { res.writeHead(500); res.end("unexpected synthetic RPC"); return; }
  res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
});
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; }
async function unusedPort() {
  const server = createServer(), port = await listen(server);
  await new Promise(resolve => server.close(resolve)); return port;
}
let child, outcome, client;
try {
  const rpcPort = await listen(rpc), port = await unusedPort();
  let operationsPort = await unusedPort(); while (operationsPort === port) operationsPort = await unusedPort();
  let output = "";
  child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), OPERATIONS_PORT: String(operationsPort), RPC_URL: `http://127.0.0.1:${rpcPort}`,
      RPC_ENDPOINTS_PATH: "", ACTIONS_GENESIS_HASH: genesisHash, CLUSTER: "localnet", BASE_URL: `http://localhost:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-8192); });
  outcome = once(child, "exit");
  const base = `http://127.0.0.1:${port}`, deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Actions exited before readiness: " + output);
    try { ready = (await fetch(`${base}/ready`)).status === 200; } catch {}
    if (ready) break; await delay(100);
  }
  assert.ok(ready, "Actions did not become ready");
  client = request(`${base}/actions/fund/${appIdHex}?amount=1`, { method: "POST" }, res => res.resume());
  client.on("error", () => {}); client.end(JSON.stringify({ account: user.toBase58() }));
  await Promise.race([entered, delay(5000, undefined, { ref: false }).then(() => { throw new Error("deposit did not reach delayed RPC"); })]);
  child.kill("SIGTERM"); client.destroy(); await delay(250);
  assert.equal(child.exitCode, null, "shutdown closed RPC while disconnected work remained"); assert.equal(child.signalCode, null);
  const metrics = await (await fetch(`http://127.0.0.1:${operationsPort}/metrics`)).text();
  assert(metrics.includes("ghostlink_actions_ready 0")); assert(metrics.includes("ghostlink_actions_active 1"));
  release();
  const [code, signal] = await Promise.race([outcome, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("graceful shutdown timed out"); })]);
  assert.equal(signal, null); assert.equal(code, 0, output); assert.equal(blocks, 1, "admitted deposit preparation did not finish");
  console.log("Actions SIGTERM drill passed: disconnected deposit preparation drained before RPC close.");
} finally {
  release(); client?.destroy();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await outcome; }
  rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve));
}
