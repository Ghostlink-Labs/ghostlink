/** Synthetic providers, disposable payer, real service entry points and HTTP. No external network. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const marker = "SYNTHETIC_SERVICE_RPC_SECRET";
const genesis = Keypair.generate().publicKey.toBase58();
const wrongGenesis = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate();
const directory = mkdtempSync(join(tmpdir(), "ghostlink-service-rpc-"));
const children = [], providers = [];
const payerPath = join(directory, "payer.json");
const configPath = join(directory, "providers.json");
writeFileSync(payerPath, JSON.stringify([...payer.secretKey]));

async function provider() {
  const state = { mode: "normal", calls: [], packets: [], statuses: 0 };
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const call = JSON.parse(raw);
      state.calls.push(call.method);
      const reply = result => res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      res.setHeader("content-type", "application/json");
      if (state.mode === "outage") { res.writeHead(503); res.end(marker); return; }
      if (call.method === "getGenesisHash") return reply(state.mode === "wrong" ? wrongGenesis : genesis);
      if (state.mode === "semantic") return res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32602, message: marker, data: { token: marker } } }));
      if (call.method === "getSignaturesForAddress") return reply([]);
      if (call.method === "getLatestBlockhash") return reply({ context: { slot: 50 }, value: { blockhash: genesis, lastValidBlockHeight: 1000 } });
      if (call.method === "getFeeForMessage") return reply({ context: { slot: 50 }, value: 10000 });
      if (call.method === "sendTransaction") {
        state.packets.push(raw);
        const signature = bs58.encode(Transaction.from(Buffer.from(call.params[0], "base64")).signature);
        if (state.mode === "drop") { res.destroy(); return; }
        if (state.mode === "reject-send") return res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32002, message: marker, data: { logs: [marker] } } }));
        return reply(signature);
      }
      if (call.method === "getSignatureStatuses") {
        state.statuses++;
        return reply({ context: { slot: 50 }, value: [{ slot: 50, confirmations: 1, err: null, confirmationStatus: "confirmed" }] });
      }
      throw new Error("unexpected test method");
    } catch { res.writeHead(500); res.end(marker); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  providers.push(server);
  return { ...state, get mode() { return state.mode; }, set mode(value) { state.mode = value; },
    get statuses() { return state.statuses; }, url: `http://127.0.0.1:${address.port}/provider/${marker}?api-key=${marker}` };
}
async function port() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  await new Promise(resolve => server.close(resolve)); return address.port;
}
async function start(name, extra = {}) {
  const listenPort = await port();
  const env = { ...process.env, PORT: String(listenPort), NODE_ENV: "production", POLL_MS: "100",
    RPC_URL: "", RPC_ENDPOINTS_PATH: configPath, INDEXER_GENESIS_HASH: genesis, RELAYER_GENESIS_HASH: genesis,
    GHOSTLINK_RELAYER_KEYPAIR: payerPath, PERSIST_PATH: join(directory, "indexer.json"), RELAYER_BUDGET_PATH: join(directory, "budget.json"),
    WATCHER_GENESIS_HASH: genesis, WATCHER_STATE_PATH: join(directory, "watcher.json"), WATCHER_POLL_MS: "100", NOTIFY_WEBHOOK: "", GHOSTLINK_WATCHER_KEYPAIR: "", ...extra };
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../../${name}/dist/index.js`, import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const state = { child, output: "", url: `http://127.0.0.1:${listenPort}` };
  child.stdout.on("data", data => { state.output += data; });
  child.stderr.on("data", data => { state.output += data; });
  children.push(state); return state;
}
async function until(work, message) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await work()) return; await delay(40); }
  throw new Error(message);
}
async function health(process) {
  try { return await (await fetch(`${process.url}/health`, { signal: AbortSignal.timeout(500) })).json(); }
  catch { return null; }
}
async function stopped(state) {
  await until(() => state.child.exitCode !== null || state.child.signalCode !== null, "service did not stop");
}
async function stop(state) {
  if (state.child.exitCode === null && state.child.signalCode === null) { state.child.kill(); await stopped(state); }
}
async function snapshot(process) {
  return fetch(`${process.url}/snapshot`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: Keypair.generate().publicKey.toBase58(), holding: payer.publicKey.toBase58() }), signal: AbortSignal.timeout(10000) });
}

try {
  const primary = await provider(), secondary = await provider();
  writeFileSync(configPath, JSON.stringify([{ url: primary.url }, { url: secondary.url, headers: { authorization: marker } }]));
  primary.mode = "wrong"; secondary.mode = "wrong";
  for (const name of ["indexer", "relayer", "watcher"]) {
    const wrong = await start(name); await stopped(wrong);
    assert.notEqual(wrong.child.exitCode, 0, `${name} accepted wrong-chain startup`);
    assert.equal(await health(wrong), null);
    assert(!wrong.output.includes(marker), `${name} startup exposed credentials`);
    const missing = await start(name, { [`${name.toUpperCase()}_GENESIS_HASH`]: "" }); await stopped(missing);
    assert.notEqual(missing.child.exitCode, 0, `${name} accepted a missing chain identity`);
  }
  assert([...primary.calls, ...secondary.calls].every(method => method === "getGenesisHash"));
  const malformed = join(directory, "malformed.json"); writeFileSync(malformed, `{ "token": "${marker}",`);
  const rejected = await start("indexer", { RPC_ENDPOINTS_PATH: malformed }); await stopped(rejected);
  assert.notEqual(rejected.child.exitCode, 0); assert(!rejected.output.includes(marker));

  secondary.mode = "normal";
  const unfundedConfig = await start("watcher", { GHOSTLINK_WATCHER_KEYPAIR: payerPath,
    WATCHER_JOURNAL_PATH: "", WATCHER_JOURNAL_KEY_PATH: "", WATCHER_TOTAL_BUDGET_LAMPORTS: "" });
  await stopped(unfundedConfig); assert.notEqual(unfundedConfig.child.exitCode, 0);
  assert(!unfundedConfig.output.includes(marker), "funded watcher configuration failure exposed diagnostics");
  const indexer = await start("indexer");
  await until(async () => Boolean((await health(indexer))?.poller?.lastSuccessAt), "indexer did not ingest through fallback");
  assert(primary.calls.every(method => method === "getGenesisHash"), "wrong-chain provider received ingestion requests");
  secondary.mode = "semantic";
  await until(async () => (await health(indexer))?.ok === false, "indexer did not report polling refusal");
  assert(!JSON.stringify(await health(indexer)).includes(marker));
  secondary.mode = "normal";
  await until(async () => (await health(indexer))?.ok === true, "indexer did not resume polling");
  await stop(indexer); assert(!indexer.output.includes(marker), "indexer logs exposed provider diagnostics");

  const readCount = secondary.calls.filter(method => method === "getSignaturesForAddress").length;
  const watcher = await start("watcher");
  await until(() => secondary.calls.filter(method => method === "getSignaturesForAddress").length > readCount, "watcher did not poll through fallback");
  secondary.mode = "semantic";
  await until(() => watcher.output.includes("watcher poll failed"), "watcher did not report polling failure");
  await stop(watcher); assert(!watcher.output.includes(marker), "watcher logs exposed provider diagnostics");
  secondary.mode = "normal";

  primary.mode = "drop";
  const relayer = await start("relayer");
  await until(async () => Boolean(await health(relayer)), "relayer did not start");
  const submitted = await snapshot(relayer); assert.equal(submitted.status, 200);
  const receipt = await submitted.json();
  assert.equal(primary.packets.length, 1); assert.equal(secondary.packets.length, 1);
  assert.equal(primary.packets[0], secondary.packets[0], "fallback changed the signed request");
  assert.equal(receipt.signature, bs58.encode(Transaction.from(Buffer.from(JSON.parse(primary.packets[0]).params[0], "base64")).signature));
  assert(secondary.statuses > 0, "confirmation bypassed fallback HTTP");
  assert.equal((await health(relayer)).spentLamports24h, "10000");
  secondary.mode = "reject-send";
  const rejectedSend = await snapshot(relayer); assert.equal(rejectedSend.status, 502);
  const rejectedBody = await rejectedSend.text(); assert(!rejectedBody.includes(marker)); assert(rejectedBody.includes("outcome unknown"));
  assert.equal((await health(relayer)).spentLamports24h, "20000");
  primary.mode = "outage"; secondary.mode = "outage";
  const unavailable = await snapshot(relayer); assert.equal(unavailable.status, 500);
  assert(!JSON.stringify(await unavailable.json()).includes(marker));
  assert.equal((await health(relayer)).spentLamports24h, "20000", "preparation failure spent budget");
  await stop(relayer); assert(!relayer.output.includes(marker), "relayer logs exposed provider diagnostics");
  console.log("Service RPC drill passed: real entry points, wrong-chain refusal, private diagnostics, cursor retry, identical-packet failover and HTTP confirmation.");
} finally {
  for (const child of children) await stop(child);
  for (const server of providers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(directory, { recursive: true, force: true });
}
