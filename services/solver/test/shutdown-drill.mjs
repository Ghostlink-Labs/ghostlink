// Real Unix-process drill: a disconnected request still owns work during SIGTERM.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { bytesToHex, hexToBytes, POCKET_PROGRAM_ID } from "@ghostlink/common";
import { SubmissionJournal } from "../dist/journal.js";

if (process.platform === "win32") throw new Error("Run this signal drill on Linux/WSL");
const dir = mkdtempSync(join(tmpdir(), "ghostlink-shutdown-"));
const key = randomBytes(32), solver = Keypair.generate(), genesisHash = Keypair.generate().publicKey.toBase58();
const scope = { genesisHash, solver: solver.publicKey.toBase58(), pocketProgram: POCKET_PROGRAM_ID };
let slot = 10, enter, release;
const entered = new Promise(resolve => { enter = resolve; });
const blocked = new Promise(resolve => { release = resolve; });
const rpc = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const call = JSON.parse(body);
  let result;
  if (call.method === "getGenesisHash") result = genesisHash;
  else if (call.method === "getBalance") result = { context: { slot: ++slot }, value: 10_000_000 };
  else if (call.method === "getSlot") { enter(); await blocked; result = ++slot; }
  else if (call.method === "getAccountInfo") result = { context: { slot: ++slot }, value: null };
  else throw new Error("unexpected RPC in shutdown drill");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
});
async function listen(server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port;
}
async function unusedPort() {
  const probe = createServer(); const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve)); return port;
}
let child, outcome, client;
try {
  const rpcPort = await listen(rpc), port = await unusedPort();
  let operationsPort = await unusedPort();
  while (operationsPort === port) operationsPort = await unusedPort();
  const keyFile = join(dir, "storage.key"), signerFile = join(dir, "solver.json"), journalFile = join(dir, "journal.sqlite");
  writeFileSync(keyFile, key, { mode: 0o600 }); writeFileSync(signerFile, JSON.stringify([...solver.secretKey]), { mode: 0o600 });
  let output = "";
  child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), OPERATIONS_PORT: String(operationsPort), RPC_URL: `http://127.0.0.1:${rpcPort}`,
      RPC_ENDPOINTS_PATH: "", SOLVER_ROUTER: "inventory", SOLVER_MIN_BALANCE_LAMPORTS: "5000000", SOLVER_GENESIS_HASH: genesisHash,
      GHOSTLINK_SOLVER_KEYPAIR: signerFile, SOLVER_JOURNAL_PATH: journalFile, SOLVER_JOURNAL_KEY_PATH: keyFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-8192); });
  outcome = once(child, "exit");
  const base = `http://127.0.0.1:${port}`, deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("solver exited before readiness: " + output);
    try { ready = (await fetch(`${base}/ready`)).status === 200; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "solver did not become ready");
  const vectors = JSON.parse(readFileSync(new URL("../../../packages/common/fixtures/vectors.json", import.meta.url), "utf8"));
  const f = vectors.intent.fields;
  const body = JSON.stringify({ pocket: bs58.encode(hexToBytes(f.pocket)), nonce: f.nonce,
    inMint: bs58.encode(hexToBytes(f.inMint)), inMax: f.inMax, outMint: bs58.encode(hexToBytes(f.outMint)), outMin: f.outMin,
    deadlineSlot: f.deadlineSlot, policyHashHex: f.policyHash, sessionKind: 0, sessionKeyHex: vectors.identity.sessionPubkey,
    signatureHex: bytesToHex(ed25519.sign(hexToBytes(vectors.intent.hash), hexToBytes(vectors.identity.sessionSeed))) });
  client = request(`${base}/intent`, { method: "POST" }, res => res.resume());
  client.on("error", () => {}); client.end(body);
  await Promise.race([entered, delay(5000, undefined, { ref: false }).then(() => { throw new Error("intent never reached the delayed RPC"); })]);
  child.kill("SIGTERM"); client.destroy(); await delay(250);
  assert.equal(child.exitCode, null, "shutdown retired the journal while disconnected work remained");
  assert.equal(child.signalCode, null, "shutdown unexpectedly killed the worker");
  release();
  const [code, signal] = await Promise.race([outcome, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("graceful shutdown timed out"); })]);
  assert.equal(signal, null); assert.equal(code, 0, output);
  const reopened = new SubmissionJournal(journalFile, key, scope); reopened.checkWritable(); reopened.close();
  console.log("SIGTERM drill passed: disconnected work drained before journal close; encrypted database reopened.");
} finally {
  release(); client?.destroy();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await outcome; }
  rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve));
  key.fill(0); rmSync(dir, { recursive: true, force: true });
}
