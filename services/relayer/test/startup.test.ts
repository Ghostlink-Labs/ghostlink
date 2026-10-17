import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import { RelayerJournal } from "../src/journal.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });
async function port() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("port unavailable");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "relayer-startup-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const payer = Keypair.generate(), key = randomBytes(32), genesis = Keypair.generate().publicKey.toBase58();
  const payerFile = join(dir, "payer.json"), keyFile = join(dir, "storage-key"), path = join(dir, "missing.db");
  writeFileSync(payerFile, JSON.stringify(Array.from(payer.secretKey))); writeFileSync(keyFile, key);
  let slot = 10, sends = 0;
  const rpc = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    if (call.method === "sendTransaction") sends++;
    const result = call.method === "getGenesisHash" ? genesis : call.method === "getBalance" ? { context: { slot: ++slot }, value: 1_000_000_000 } : null;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  cleanup.push(() => new Promise<void>(resolve => { rpc.closeAllConnections(); rpc.close(() => resolve()); }));
  const address = rpc.address(); if (!address || typeof address === "string") throw new Error("RPC port unavailable");
  const publicPort = await port(); let opsPort = await port(); while (opsPort === publicPort) opsPort = await port();
  const env = { ...process.env, PORT: String(publicPort), OPERATIONS_PORT: String(opsPort),
    GHOSTLINK_RELAYER_KEYPAIR: payerFile, RELAYER_JOURNAL_KEY_PATH: keyFile, RELAYER_JOURNAL_PATH: path,
    RELAYER_JOURNAL_ID: "01".repeat(32), RELAYER_GENESIS_HASH: genesis, RELAYER_BUDGET_PATH: "",
    RPC_ENDPOINTS_PATH: "", RPC_URL: `http://127.0.0.1:${address.port}` };
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
        if (output.includes("ghostlink relayer on")) { started = true; clearTimeout(timer); resolve({ started, code: null }); }
      });
      child.stderr.on("data", bytes => { output += bytes; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve({ started, code }); });
    });
    return { ...result, stop, output };
  }
  return { dir, path, key, payer, genesis, env, start, sends: () => sends };
}
const scopeFor = (w: Awaited<ReturnType<typeof fixture>>) => ({ genesisHash: w.genesis, payer: w.payer.publicKey.toBase58(),
  pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() });

it("refuses a missing journal instead of silently creating empty spending history", async () => {
  const w = await fixture(), result = await w.start();
  await result.stop();
  expect(result.started).toBe(false);
  expect(result.code).toBe(1);
  expect(existsSync(w.path)).toBe(false);
  expect(w.sends()).toBe(0);
}, 20000);

it("pins the existing journal identity, preserves spending, and refuses empty or damaged state", async () => {
  const w = await fixture(), scope = scopeFor(w);
  writeFileSync(w.path, ""); const empty = await w.start(); expect(empty.code).toBe(1); expect(readFileSync(w.path).length).toBe(0);
  const original = new RelayerJournal(w.path, w.key, scope), id = "21".repeat(32), digest = "22".repeat(32);
  const tx = new Transaction({ feePayer: w.payer.publicKey, recentBlockhash: w.genesis })
    .add(SystemProgram.transfer({ fromPubkey: w.payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1n }));
  tx.sign(w.payer);
  const claim = original.claim(id, digest);
  original.prepare(id, claim.token!, { rawBase64: tx.serialize().toString("base64"), signature: bs58.encode(tx.signature!),
    blockhash: w.genesis, minContextSlot: 1, lastValidBlockHeight: 100, feeLamports: "5000", rentLamports: "0" },
    { balanceLamports: 1_000_000_000n, slot: 1, minimumReserveLamports: 0n });
  const journalId = original.instanceId!, packet = original.get(id)!.packet; original.close();
  expect((await w.start()).code).toBe(1); // Correct key and scope, wrong pinned instance.
  expect((await w.start({ RELAYER_JOURNAL_ID: "" })).code).toBe(1);
  const good = await w.start({ RELAYER_JOURNAL_ID: journalId }); expect(good.started).toBe(true); await good.stop();
  const reopened = RelayerJournal.openExisting(w.path, w.key, scope, journalId);
  expect(reopened.spent()).toBe(5000n); expect(reopened.get(id)!.packet).toEqual(packet); reopened.close();
  const otherPath = join(w.dir, "other.sqlite"), other = new RelayerJournal(otherPath, w.key, scope);
  expect(other.instanceId).not.toBe(journalId); other.close();
  expect((await w.start({ RELAYER_JOURNAL_PATH: otherPath, RELAYER_JOURNAL_ID: journalId })).code).toBe(1);
  const corrupt = new DatabaseSync(w.path); corrupt.exec("DROP TABLE operations"); corrupt.close();
  expect((await w.start({ RELAYER_JOURNAL_ID: journalId })).code).toBe(1);
  const check = new DatabaseSync(w.path, { readOnly: true });
  expect(check.prepare("SELECT name FROM sqlite_master WHERE name='operations'").all()).toHaveLength(0); check.close();
  expect(w.sends()).toBe(0);
}, 30000);

it("keeps journals without an instance marker available for maintenance but closed to hosted paid work", async () => {
  const w = await fixture(), scope = scopeFor(w), created = new RelayerJournal(w.path, w.key, scope);
  const instanceId = created.instanceId!; created.close();
  const old = new DatabaseSync(w.path); old.exec("DELETE FROM metadata WHERE name='relayer-instance-v1'"); old.close();
  expect((await w.start({ RELAYER_JOURNAL_ID: instanceId })).code).toBe(1);
  const maintenance = RelayerJournal.openForMaintenance(w.path, w.key, scope);
  try {
    expect(maintenance.instanceId).toBeUndefined(); expect(maintenance.page().records).toEqual([]);
    expect(() => maintenance.claim("01".repeat(32), "02".repeat(32))).toThrow(/forbids/);
    maintenance.rotateKey(randomBytes(32)); expect(maintenance.instanceId).toBeUndefined();
  } finally { maintenance.close(); }
}, 20000);

it("initializes a fresh payer and pinned journal exactly once, then starts the real service", async () => {
  const w = await fixture(), directory = join(w.dir, "fresh"), cli = join(process.cwd(), "dist/initialize.js");
  const init = (target: string, genesis = w.genesis) => spawnSync(process.execPath, [cli, target], {
    env: { ...w.env, RELAYER_GENESIS_HASH: genesis }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  const result = init(directory); expect(result.status, result.stderr).toBe(0);
  const deployment = JSON.parse(readFileSync(join(directory, "deployment.json"), "utf8"));
  const payerFile = join(directory, deployment.files.payer), keyFile = join(directory, deployment.files.storageKey);
  const payerBytes = readFileSync(payerFile), keyBytes = readFileSync(keyFile);
  expect(deployment.scope.payer).not.toBe(w.payer.publicKey.toBase58()); expect(keyBytes).toHaveLength(32);
  expect(result.stdout).not.toContain(payerBytes.toString().trim());
  if (process.platform !== "win32") for (const file of [directory, payerFile, keyFile]) expect(statSync(file).mode & 0o077).toBe(0);
  expect(init(directory).status).toBe(1); expect(readFileSync(payerFile)).toEqual(payerBytes); expect(readFileSync(keyFile)).toEqual(keyBytes);
  const started = await w.start({ GHOSTLINK_RELAYER_KEYPAIR: payerFile, RELAYER_JOURNAL_KEY_PATH: keyFile,
    RELAYER_JOURNAL_PATH: join(directory, deployment.files.journal), RELAYER_JOURNAL_ID: deployment.journalId });
  expect(started.started).toBe(true); await started.stop();
  const publicTarget = join(w.dir, "public-chain");
  expect(init(publicTarget, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d").status).toBe(1); expect(existsSync(publicTarget)).toBe(false);
  expect(w.sends()).toBe(0);
}, 30000);
