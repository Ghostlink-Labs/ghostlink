/** Synthetic providers, disposable payer, real service entry points and HTTP. No external network. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
import { POCKET, REGISTRY, CENSUS, POCKET_ACCOUNT_SIZE, pocketPda } from "@ghostlink/service-kit";
import { RelayerJournal } from "@ghostlink/relayer/journal";
import { WatcherState } from "@ghostlink/watcher";
import { IndexerDatabase } from "../../indexer/dist/database.js";

const marker = "SYNTHETIC_SERVICE_RPC_SECRET";
const genesis = Keypair.generate().publicKey.toBase58();
const wrongGenesis = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate();
const appIdHex = "01".repeat(32), pocketData = Buffer.alloc(POCKET_ACCOUNT_SIZE);
createHash("sha256").update("account:PocketV3").digest().copy(pocketData, 0, 0, 8);
Buffer.from(appIdHex, "hex").copy(pocketData, 8); payer.publicKey.toBuffer().copy(pocketData, 72);
const directory = mkdtempSync(join(tmpdir(), "ghostlink-service-rpc-"));
const children = [], providers = [], accepted = new Set();
const journalKeyPath = join(directory, "journal.key");
const journalKey = randomBytes(32);
writeFileSync(journalKeyPath, journalKey);
const initializedJournal = new RelayerJournal(join(directory, "relayer.db"), journalKey, {
  genesisHash: genesis, payer: payer.publicKey.toBase58(), pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58(),
});
const relayerJournalId = initializedJournal.instanceId;
initializedJournal.close();
const initializedWatcher = new WatcherState(join(directory, "watcher.sqlite"), journalKey, {
  genesisHash: genesis, pocketProgram: POCKET.toBase58(), payer: null,
  receiver: createHash("sha256").update("").digest("hex"), threshold: "100000000",
});
const watcherStateId = initializedWatcher.instanceId;
initializedWatcher.close();
const initializedIndexer = new IndexerDatabase(join(directory, "indexer.db"), journalKey,
  JSON.stringify({ genesisHash: genesis, programs: [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), commitment: "finalized" }));
const indexerStateId = initializedIndexer.instanceId; initializedIndexer.close(); journalKey.fill(0);
const payerPath = join(directory, "payer.json");
const configPath = join(directory, "providers.json");
writeFileSync(payerPath, JSON.stringify([...payer.secretKey]));

let slot = 50;
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
      if (call.method === "getBalance") return reply({ context: { slot: ++slot }, value: 1_000_000_000 });
      if (call.method === "getSignaturesForAddress") return reply([]);
      if (call.method === "getLatestBlockhash") return reply({ context: { slot }, value: { blockhash: genesis, lastValidBlockHeight: 1000 } });
      if (call.method === "getSlot") return reply(++slot);
      if (call.method === "getMultipleAccounts") return reply({ context: { slot }, value: [{ owner: POCKET.toBase58(), executable: false, lamports: 1, rentEpoch: 0, data: [pocketData.toString("base64"), "base64"] }] });
      if (call.method === "getBlockHeight") return reply(slot);
      if (call.method === "getFeeForMessage") return reply({ context: { slot }, value: 10000 });
      if (call.method === "sendTransaction") {
        state.packets.push(raw);
        const signature = bs58.encode(Transaction.from(Buffer.from(call.params[0], "base64")).signature);
        if (state.mode === "drop") { res.destroy(); return; }
        if (state.mode === "reject-send") return res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32002, message: marker, data: { logs: [marker] } } }));
        accepted.add(signature); return reply(signature);
      }
      if (call.method === "getSignatureStatuses") {
        state.statuses++;
        return reply({ context: { slot }, value: call.params[0].map(id => accepted.has(id) ? { slot, confirmations: 1, err: null, confirmationStatus: "confirmed" } : null) });
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
  let operationsPort = await port(); while (operationsPort === listenPort) operationsPort = await port();
  const env = { ...process.env, PORT: String(listenPort), OPERATIONS_PORT: String(operationsPort), NODE_ENV: "production", POLL_MS: "100",
    ACTIONS_GENESIS_HASH: genesis, CLUSTER: "localnet", BASE_URL: `http://localhost:${listenPort}`, RPC_URL: "", RPC_ENDPOINTS_PATH: configPath, INDEXER_GENESIS_HASH: genesis, INDEXER_STATE_ID: indexerStateId, RELAYER_GENESIS_HASH: genesis,
    GHOSTLINK_RELAYER_KEYPAIR: payerPath, PERSIST_PATH: "", INDEXER_STATE_PATH: join(directory, "indexer.db"), INDEXER_STATE_KEY_PATH: journalKeyPath, RELAYER_BUDGET_PATH: "", RELAYER_JOURNAL_PATH: join(directory, "relayer.db"), RELAYER_JOURNAL_KEY_PATH: journalKeyPath, RELAYER_JOURNAL_ID: relayerJournalId,
    WATCHER_GENESIS_HASH: genesis, WATCHER_STATE_PATH: join(directory, "watcher.sqlite"), WATCHER_STATE_KEY_PATH: journalKeyPath, WATCHER_STATE_ID: watcherStateId, LARGE_FILL_USD_E6: "100000000", WATCHER_PORT: String(listenPort), WATCHER_POLL_MS: "100", NOTIFY_WEBHOOK: "", GHOSTLINK_WATCHER_KEYPAIR: "", ...extra };
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
async function ready(process) {
  try { return (await fetch(`${process.url}/ready`, { signal: AbortSignal.timeout(500) })).status === 200; } catch { return false; }
}
async function stopped(state) {
  await until(() => state.child.exitCode !== null || state.child.signalCode !== null, "service did not stop");
}
async function stop(state) {
  if (state.child.exitCode === null && state.child.signalCode === null) { state.child.kill(); await stopped(state); }
}
const snapshotBody = () => ({ requestIdHex: randomBytes(32).toString("hex"), wallet: Keypair.generate().publicKey.toBase58(), holding: payer.publicKey.toBase58() });
async function snapshot(process, body = snapshotBody()) {
  return fetch(`${process.url}/snapshot`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
}

try {
  const primary = await provider(), secondary = await provider();
  writeFileSync(configPath, JSON.stringify([{ url: primary.url }, { url: secondary.url, headers: { authorization: marker } }]));
  primary.mode = "wrong"; secondary.mode = "wrong";
  for (const name of ["indexer", "relayer", "watcher", "actions"]) {
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

  const actions = await start("actions");
  await until(() => ready(actions), "Actions did not establish chain readiness through fallback");
  const fundingUrl = `${actions.url}/actions/fund/${appIdHex}?amount=1`;
  const deposit = () => fetch(fundingUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: payer.publicKey.toBase58() }) });
  const funding = await deposit(); assert.equal(funding.status, 200);
  assert.equal(funding.headers.get("x-blockchain-ids"), `solana:${genesis.slice(0, 32)}`);
  const fundingTx = Transaction.from(Buffer.from((await funding.json()).transaction, "base64"));
  assert.equal(fundingTx.instructions.length, 1);
  assert(fundingTx.instructions[0].keys[1].pubkey.equals(pocketPda(Buffer.from(appIdHex, "hex"))));
  assert(fundingTx.signatures.every(s => s.signature === null));
  secondary.mode = "outage";
  await until(async () => !await ready(actions), "Actions admission survived provider outage");
  const refused = await deposit(); assert.equal(refused.status, 503); assert(!(await refused.text()).includes(marker));
  assert.equal((await health(actions)).ok, true);
  secondary.mode = "normal";
  await until(() => ready(actions), "Actions did not recover readiness");
  assert.equal((await deposit()).status, 200);
  await stop(actions); assert(!actions.output.includes(marker), "Actions logs exposed credentials");

  primary.mode = "drop";
  let relayer = await start("relayer");
  await until(async () => await ready(relayer), "relayer did not start");
  const originalBody = snapshotBody();
  const submitted = await snapshot(relayer, originalBody); assert.equal(submitted.status, 200);
  const receipt = await submitted.json();
  assert.equal(primary.packets.length, 1); assert.equal(secondary.packets.length, 1);
  assert.equal(primary.packets[0], secondary.packets[0], "fallback changed the signed request");
  assert.equal(receipt.signature, bs58.encode(Transaction.from(Buffer.from(JSON.parse(primary.packets[0]).params[0], "base64")).signature));
  assert(secondary.statuses > 0, "confirmation bypassed fallback HTTP");
  await until(async () => (await health(relayer))?.spentLamports24h === "10000", "cached spending did not refresh");
  await stop(relayer); relayer = await start("relayer");
  await until(async () => await ready(relayer), "relayer did not reopen its journal");
  const repeated = await snapshot(relayer, originalBody); assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).signature, receipt.signature);
  assert.equal(primary.packets.length, 1); assert.equal(secondary.packets.length, 1);
  await until(async () => (await health(relayer))?.spentLamports24h === "10000", "cached spending did not refresh");
  secondary.mode = "reject-send";
  const rejectedSend = await snapshot(relayer); assert.equal(rejectedSend.status, 202);
  const rejectedBody = await rejectedSend.text(); assert(!rejectedBody.includes(marker)); assert.equal(JSON.parse(rejectedBody).state, "pending");
  await until(async () => (await health(relayer))?.spentLamports24h === "20000", "cached spending did not refresh");
  primary.mode = "outage"; secondary.mode = "outage";
  await until(async () => !await ready(relayer), "relayer admission survived total outage");
  const unavailable = await snapshot(relayer); assert.equal(unavailable.status, 503);
  assert(!JSON.stringify(await unavailable.json()).includes(marker));
  assert.equal((await health(relayer)).spentLamports24h, "20000", "preparation failure spent budget");
  await stop(relayer); assert(!relayer.output.includes(marker), "relayer logs exposed provider diagnostics");
  console.log("Service RPC drill passed: real entry points, wrong-chain refusal, private diagnostics, cursor retry, identical-packet failover and HTTP confirmation.");
} finally {
  for (const child of children) await stop(child);
  for (const server of providers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(directory, { recursive: true, force: true });
}
