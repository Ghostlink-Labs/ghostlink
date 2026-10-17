import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@solana/web3.js";
import { POCKET } from "@ghostlink/service-kit";
import { CrankJournal } from "../src/journal.js";
import { WatcherState } from "../src/state.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });
const limits = { maximumFeeLamports: 10000, totalBudgetLamports: 20000 };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "watcher-startup-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const payer = Keypair.generate(), key = randomBytes(32), genesis = Keypair.generate().publicKey.toBase58();
  const payerFile = join(dir, "payer.json"), keyFile = join(dir, "key"), path = join(dir, "state.sqlite"), journalPath = join(dir, "cranks.sqlite");
  writeFileSync(payerFile, JSON.stringify(Array.from(payer.secretKey))); writeFileSync(keyFile, key);
  let sends = 0;
  const rpc = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const call = JSON.parse(body); if (call.method === "sendTransaction") sends++;
    // Permit startup but stop scanning so preserved pending delivery can be inspected without sending it.
    if (call.method === "getGenesisHash") res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: genesis }));
    else res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32603, message: "synthetic outage" } }));
  });
  rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  cleanup.push(() => new Promise<void>(resolve => { rpc.closeAllConnections(); rpc.close(() => resolve()); }));
  const address = rpc.address(); if (!address || typeof address === "string") throw new Error("RPC port unavailable");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const listen = probe.address(); if (!listen || typeof listen === "string") throw new Error("port unavailable");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const env = { ...process.env, WATCHER_PORT: String(listen.port), WATCHER_POLL_MS: "30000", WATCHER_GENESIS_HASH: genesis,
    WATCHER_STATE_PATH: path, WATCHER_STATE_KEY_PATH: keyFile, WATCHER_STATE_ID: "01".repeat(32),
    GHOSTLINK_WATCHER_KEYPAIR: payerFile, WATCHER_JOURNAL_PATH: journalPath, WATCHER_JOURNAL_KEY_PATH: keyFile, WATCHER_JOURNAL_ID: "02".repeat(32),
    WATCHER_MAX_FEE_LAMPORTS: String(limits.maximumFeeLamports), WATCHER_TOTAL_BUDGET_LAMPORTS: String(limits.totalBudgetLamports),
    NOTIFY_WEBHOOK: "", LARGE_FILL_USD_E6: "1", RPC_ENDPOINTS_PATH: "", RPC_URL: `http://127.0.0.1:${address.port}` };
  async function start(extra: Record<string, string> = {}) {
    const child = spawn(process.execPath, [join(process.cwd(), "dist/index.js")], { env: { ...env, ...extra }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", started = false;
    const exited = once(child, "exit");
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
    cleanup.push(stop);
    const result = await new Promise<{ started: boolean; code: number | null }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("startup did not settle")); }, 10000);
      child.stdout.on("data", bytes => {
        output += bytes;
        if (output.includes("ghostlink watcher running")) { started = true; clearTimeout(timer); resolve({ started, code: null }); }
      });
      child.stderr.on("data", bytes => { output += bytes; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve({ started, code }); });
    });
    return { ...result, stop, output };
  }
  const scope = { genesisHash: genesis, pocketProgram: POCKET.toBase58(), payer: payer.publicKey.toBase58() };
  const stateScope = { ...scope, receiver: createHash("sha256").update("").digest("hex"), threshold: "1" };
  return { dir, path, journalPath, key, payer, genesis, scope, stateScope, env, start, sends: () => sends };
}

it("refuses missing watcher state instead of starting with empty notification and fee history", async () => {
  const w = await fixture(), result = await w.start(); await result.stop();
  expect(result.started).toBe(false); expect(result.code).toBe(1);
  expect(existsSync(w.path)).toBe(false); expect(existsSync(w.journalPath)).toBe(false); expect(w.sends()).toBe(0);
  expect((await w.start({ GHOSTLINK_WATCHER_KEYPAIR: "" })).code).toBe(1);
  expect(existsSync(w.path)).toBe(false);
}, 20000);

it("refuses a deleted cumulative spending record instead of treating prior spending as zero", async () => {
  const w = await fixture(), journal = new CrankJournal(w.journalPath, w.key, w.scope, limits);
  cleanup.push(() => journal.close());
  journal.prepare(w.payer.publicKey.toBase58(), "proposal", { rawBase64: "cGFja2V0", signature: "saved-signature", blockhash: w.genesis,
    minContextSlot: 1, lastValidBlockHeight: 100 }, 5000);
  const changed = new DatabaseSync(w.journalPath); changed.exec("DELETE FROM spending"); changed.close();
  expect(() => journal.spent()).toThrow();
  expect(() => journal.checkWritable()).toThrow(/spending/);
  expect(() => journal.prepare(Keypair.generate().publicKey.toBase58(), "other", { rawBase64: "cGFja2V0", signature: "other", blockhash: w.genesis,
    minContextSlot: 1, lastValidBlockHeight: 100 }, 5000)).toThrow(/spending/);
  const journalId = journal.instanceId!; journal.close();
  expect(() => CrankJournal.openExisting(w.journalPath, w.key, w.scope, limits, journalId)).toThrow(/spending/);
  expect((await w.start({ WATCHER_JOURNAL_ID: journalId })).code).toBe(1);
  const check = new DatabaseSync(w.journalPath, { readOnly: true });
  expect(check.prepare("SELECT * FROM spending").all()).toHaveLength(0); check.close();
});

it("preserves the delivery checkpoint and refuses a wrong pin before claiming ownership", async () => {
  const w = await fixture(), scope = { ...w.stateScope, payer: null }, state = new WatcherState(w.path, w.key, scope);
  const stateId = state.instanceId!;
  state.begin(10); state.page(undefined, [{ signature: "A", slot: 1, err: null, memo: null, blockTime: null }], 1000);
  const delivery = state.prepare(state.oldest()!, [], [{ subject: "first", body: {} }, { subject: "second", body: {} }]);
  state.acknowledge(String(delivery.alerts[0]!.body.eventId)); state.close();
  expect(() => WatcherState.openExisting(w.path, w.key, scope, "ff".repeat(32))).toThrow(/identity/);
  const inspect = new DatabaseSync(w.path, { readOnly: true });
  expect(inspect.prepare("SELECT name FROM state WHERE name='lease'").all()).toHaveLength(0); inspect.close();
  const opened = WatcherState.openExisting(w.path, w.key, scope, stateId);
  expect(opened.delivery()).toEqual({ ...delivery, next: 1 }); expect(opened.snapshot().cursor).toBeUndefined(); opened.close();
  expect((await w.start({ GHOSTLINK_WATCHER_KEYPAIR: "", WATCHER_STATE_ID: "ff".repeat(32) })).code).toBe(1);
  expect((await w.start({ GHOSTLINK_WATCHER_KEYPAIR: "", WATCHER_STATE_ID: "" })).code).toBe(1);
  const otherPath = join(w.dir, "other.sqlite"), other = new WatcherState(otherPath, w.key, scope); other.close();
  expect((await w.start({ GHOSTLINK_WATCHER_KEYPAIR: "", WATCHER_STATE_PATH: otherPath, WATCHER_STATE_ID: stateId })).code).toBe(1);
  expect(w.sends()).toBe(0);
}, 30000);

it("refuses deleted observation markers, checkpoint records and schema without recreating them", async () => {
  const w = await fixture(), scope = { ...w.stateScope, payer: null };
  for (const [name, sql] of Object.entries({ snapshot: "DELETE FROM state WHERE name='snapshot'", through: "DELETE FROM state WHERE name='through'",
    identity: "DELETE FROM metadata WHERE name='watcher-instance-v1'", schema: "DROP TABLE observations" })) {
    const path = join(w.dir, name + ".sqlite"), state = new WatcherState(path, w.key, scope), id = state.instanceId!; state.close();
    const changed = new DatabaseSync(path); changed.exec(sql); changed.close();
    expect(() => WatcherState.openExisting(path, w.key, scope, id)).toThrow();
    const result = await w.start({ GHOSTLINK_WATCHER_KEYPAIR: "", WATCHER_STATE_PATH: path, WATCHER_STATE_ID: id });
    expect(result.code).toBe(1);
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare("SELECT name FROM state WHERE name='lease'").all()).toHaveLength(0);
    const count = name === "schema" ? check.prepare("SELECT name FROM sqlite_master WHERE name='observations'").all().length :
      name === "identity" ? check.prepare("SELECT name FROM metadata WHERE name='watcher-instance-v1'").all().length :
      check.prepare("SELECT name FROM state WHERE name=?").all(name).length;
    expect(count).toBe(0); check.close();
  }
}, 30000);

it("preserves cumulative fees and packets under the journal pin and rejects substitution and marker loss", async () => {
  const w = await fixture(), original = new CrankJournal(w.journalPath, w.key, w.scope, limits), journalId = original.instanceId!;
  const packet = { rawBase64: "cGFja2V0", signature: "saved", blockhash: w.genesis, minContextSlot: 1, lastValidBlockHeight: 100 };
  original.prepare(w.scope.payer, "proposal", packet, 5000); original.close();
  const valid = CrankJournal.openExisting(w.journalPath, w.key, w.scope, limits, journalId);
  expect(valid.spent()).toBe(5000); expect(valid.get(w.scope.payer)!.packet).toEqual(packet);
  const otherPath = join(w.dir, "other-journal.sqlite"), other = new CrankJournal(otherPath, w.key, w.scope, limits); other.close();
  expect(() => CrankJournal.openExisting(otherPath, w.key, w.scope, limits, journalId)).toThrow(/identity/);
  expect((await w.start({ WATCHER_JOURNAL_PATH: otherPath, WATCHER_JOURNAL_ID: journalId })).code).toBe(1);
  const changed = new DatabaseSync(w.journalPath); changed.exec("DELETE FROM metadata WHERE name='crank-instance-v1'"); changed.close();
  expect(() => valid.checkWritable()).toThrow(/identity/);
  expect(() => valid.observe(w.scope.payer, packet.signature, "pending", 2)).toThrow(/identity/); valid.close();
  expect((await w.start({ WATCHER_JOURNAL_ID: journalId })).code).toBe(1); expect(w.sends()).toBe(0);
}, 30000);

it.each(["observer", "funded"])("explicitly provisions %s state once and starts the real service with its pins", async mode => {
  const w = await fixture(), directory = join(w.dir, "fresh"), cli = join(process.cwd(), "dist/initialize.js");
  const init = (target: string, genesis = w.genesis) => spawnSync(process.execPath, [cli, mode, target], {
    env: { ...w.env, WATCHER_GENESIS_HASH: genesis }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  const result = init(directory); expect(result.status, result.stderr).toBe(0);
  const manifest = readFileSync(join(directory, "deployment.json")), deployment = JSON.parse(manifest.toString());
  expect(deployment.mode).toBe(mode); expect(deployment.stateId).toMatch(/^[0-9a-f]{64}$/);
  const files = deployment.files, stateKey = readFileSync(join(directory, files.stateKey)); expect(stateKey).toHaveLength(32);
  if (mode === "funded") {
    expect(deployment.scope.payer).not.toBe(w.scope.payer); expect(deployment.journalId).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(directory, files.journalKey))).not.toEqual(stateKey);
    expect(result.stdout).not.toContain(readFileSync(join(directory, files.payer), "utf8").trim());
  } else { expect(deployment.scope.payer).toBeNull(); expect(files.payer).toBeUndefined(); expect(existsSync(join(directory, "payer.json"))).toBe(false); }
  if (process.platform !== "win32") for (const file of [directory, ...Object.values(files).map(name => join(directory, String(name)))]) expect(statSync(file).mode & 0o077).toBe(0);
  expect(init(directory).status).toBe(1); expect(readFileSync(join(directory, "deployment.json"))).toEqual(manifest);
  const config = { WATCHER_STATE_PATH: join(directory, files.state), WATCHER_STATE_KEY_PATH: join(directory, files.stateKey), WATCHER_STATE_ID: deployment.stateId,
    GHOSTLINK_WATCHER_KEYPAIR: mode === "funded" ? join(directory, files.payer) : "",
    ...(mode === "funded" ? { WATCHER_JOURNAL_PATH: join(directory, files.journal), WATCHER_JOURNAL_KEY_PATH: join(directory, files.journalKey), WATCHER_JOURNAL_ID: deployment.journalId } : {}) };
  const started = await w.start(config); expect(started.started, started.output).toBe(true); await started.stop();
  const publicTarget = join(w.dir, "public-chain");
  expect(init(publicTarget, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d").status).toBe(1); expect(existsSync(publicTarget)).toBe(false);
  expect(w.sends()).toBe(0);
}, 30000);
