/** Real Unix process termination while an approved HTTP transaction read is in flight. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { REGISTRY, CENSUS, POCKET } from "@ghostlink/service-kit";
import { IndexerDatabase } from "../dist/database.js";

if (process.platform === "win32") throw new Error("This drill requires real Unix signal delivery");
const dir = mkdtempSync(join(tmpdir(), "indexer-drain-")), key = randomBytes(32), genesisHash = Keypair.generate().publicKey.toBase58();
const keyPath = join(dir, "state.key"), path = join(dir, "indexer.db"), signature = bs58.encode(new Uint8Array(64).fill(7));
writeFileSync(keyPath, key);
const children = []; let held, transactionReads = 0;
const provider = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const call = JSON.parse(raw), reply = result => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result })); };
  if (call.method === "getGenesisHash") return reply(genesisHash);
  if (call.method === "getSlot") return reply(10);
  if (call.method === "getSignaturesForAddress") return reply(call.params[0] === REGISTRY.toBase58() ? [{ signature, slot: 10, err: null, memo: null, blockTime: null, confirmationStatus: "finalized" }] : []);
  if (call.method === "getTransaction") {
    transactionReads++;
    held = () => reply({ slot: 10, blockTime: null, version: "legacy", meta: { err: null, fee: 0, preBalances: [], postBalances: [], logMessages: [] },
      transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, accountKeys: [REGISTRY.toBase58()], recentBlockhash: genesisHash, instructions: [] } } });
    return;
  }
  res.writeHead(500); res.end("unexpected synthetic method");
});
async function until(work, message) { const end = Date.now() + 10_000; while (Date.now() < end) { if (await work()) return; await delay(30); } throw new Error(message); }
async function start(rpcUrl) {
  const port = createServer(); port.listen(0, "127.0.0.1"); await once(port, "listening"); const n = port.address().port; await new Promise(resolve => port.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], { env: { ...process.env,
    PORT: String(n), RPC_URL: rpcUrl, RPC_ENDPOINTS_PATH: "", INDEXER_GENESIS_HASH: genesisHash, INDEXER_STATE_PATH: path,
    INDEXER_STATE_KEY_PATH: keyPath, PERSIST_PATH: "", POLL_MS: "100", INDEXER_PACE_MS: "0", INGEST_COMMITMENT: "finalized" }, stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, output: "", url: `http://127.0.0.1:${n}` }; children.push(state);
  child.stdout.on("data", b => state.output += b); child.stderr.on("data", b => state.output += b); return state;
}
try {
  provider.listen(0, "127.0.0.1"); await once(provider, "listening"); const rpcUrl = `http://127.0.0.1:${provider.address().port}`;
  const first = await start(rpcUrl); await until(() => Boolean(held), "indexer did not reach held transaction read");
  first.child.kill("SIGTERM"); await delay(150); assert.equal(first.child.exitCode, null, "indexer exited before in-flight transaction checkpoint");
  held(); await until(() => first.child.exitCode !== null, "indexer did not finish draining"); assert.equal(first.child.exitCode, 0, first.output);
  const db = new IndexerDatabase(path, key, JSON.stringify({ genesisHash, programs: [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), commitment: "finalized" }));
  assert.equal(db.snapshot().cursors[REGISTRY.toBase58()], signature); assert.equal(db.pending(), 0); db.close();
  const restarted = await start(rpcUrl);
  await until(async () => { try { return (await fetch(`${restarted.url}/ready`)).status === 200; } catch { return false; } }, "restarted indexer never became ready");
  assert.equal(transactionReads, 1, "restart replayed a checkpointed transaction"); restarted.child.kill("SIGTERM");
  await until(() => restarted.child.exitCode !== null, "restarted indexer did not stop"); assert.equal(restarted.child.exitCode, 0, restarted.output);
  console.log("Indexer drain drill passed: in-flight checkpoint completed, lease released, restart retained cursor without replay.");
} finally {
  for (const { child } of children) if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); key.fill(0); rmSync(dir, { recursive: true, force: true });
}
