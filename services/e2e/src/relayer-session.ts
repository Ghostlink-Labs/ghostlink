/** Disposable-localnet relayer with a real persistent journal and an optional lost-reply drill. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Connection, Keypair } from "@solana/web3.js";
import { POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import { buildServer } from "@ghostlink/relayer/server";
import { RelayerJournal } from "@ghostlink/relayer/journal";

export async function startRelayerFixture(connection: Connection, payer: Keypair, port = 0) {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-relayer-e2e-")), path = join(dir, "relayer.db"), key = randomBytes(32);
  const scope = { genesisHash: await connection.getGenesisHash(), payer: payer.publicKey.toBase58(), pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() };
  let armed = false, hidden = false;
  const packets: string[] = [];
  const transport = new Proxy(connection, { get(target, prop) {
    if (prop === "sendRawTransaction") return async (...args: Parameters<Connection["sendRawTransaction"]>) => {
      packets.push(Buffer.from(args[0]).toString("base64"));
      const signature = await target.sendRawTransaction(...args);
      if (armed) { armed = false; hidden = true; throw new Error("synthetic accepted reply lost"); }
      return signature;
    };
    if (prop === "getSignatureStatuses") return async (...args: Parameters<Connection["getSignatureStatuses"]>) => {
      if (hidden) throw new Error("synthetic receipt outage");
      return target.getSignatureStatuses(...args);
    };
    const value = Reflect.get(target, prop, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const initialized = new RelayerJournal(path, key, scope), journalId = initialized.instanceId!;
  initialized.close();
  let journal = RelayerJournal.openExisting(path, key, scope, journalId), server = buildServer({ connection: transport, payer, journal, minWalletLamports: 1n });
  async function listen() {
    server.listen(port, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert(address && typeof address !== "string"); port = address.port;
    const deadline = Date.now() + 20_000;
    while (!server.operations.snapshot().ready && Date.now() < deadline) await delay(100);
    assert(server.operations.snapshot().ready, "relayer did not establish advancing chain and funding readiness");
    return `http://127.0.0.1:${port}`;
  }
  const url = await listen();
  async function stop() {
    server.drain(); assert.equal(server.active, 0); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const deadline = Date.now() + 15_000;
    while (!server.operations.idle && Date.now() < deadline) await delay(50);
    assert(server.operations.idle, "relayer probe did not drain"); server.operations.stop(); journal.close();
  }
  return { url,
    backupForDrill: () => journal.backupTo(join(dir, "before-sweep.enc")),
    async verifyBackupDrill(historyConnection: Connection) {
      const target = await historyConnection.getSlot("confirmed"), deadline = Date.now() + 60_000;
      while (await historyConnection.getSlot("finalized") < target) {
        if (Date.now() > deadline) throw new Error("relayer backup history did not finalize");
        await delay(250);
      }
      const file = RelayerJournal.restoreBackup(join(dir, "before-sweep.enc"), join(dir, "restored"), key, scope);
      assert.throws(() => new RelayerJournal(file, key, scope), /restored/);
      assert.throws(() => RelayerJournal.openExisting(file, key, scope, journalId), /restored/);
      const restored = RelayerJournal.openForMaintenance(file, key, scope);
      try {
        const retained = restored.page(), live = journal.page();
        assert(live.records.some(r => !retained.records.some(saved => saved.id === r.id)), "snapshot must omit a later paid operation");
        const paidBefore = await historyConnection.getBalance(payer.publicKey, "finalized"), chargedBefore = restored.spent();
        const scopeFile = join(dir, "scope.json"), keyFile = join(dir, "storage-key"), reportFile = join(dir, "reconciliation.json");
        writeFileSync(scopeFile, JSON.stringify(scope), { mode: 0o600 }); writeFileSync(keyFile, key, { mode: 0o600 });
        const cli = join(process.env.REPO_ROOT!, "services/relayer/dist/maintenance.js");
        await promisify(execFile)(process.execPath, [cli, "reconcile", reportFile], {
          timeout: 30_000, env: { ...process.env, GHOSTLINK_RELAYER_KEYPAIR: "", RPC_ENDPOINTS_PATH: "", RPC_URL: historyConnection.rpcEndpoint,
            RELAYER_JOURNAL_PATH: file, RELAYER_JOURNAL_KEY_PATH: keyFile, RELAYER_MAINTENANCE_SCOPE_PATH: scopeFile },
        });
        const report = JSON.parse(readFileSync(reportFile, "utf8")) as { entries: { requestIdHex: string; outcome: string }[]; paidResumptionAllowed: boolean; historyCompleteness: string; nextCursor?: string };
        assert.equal(report.entries.length, retained.records.length); assert.equal(report.nextCursor, undefined);
        assert(report.entries.length > 0 && report.entries.every(r => r.outcome === "verified-finalized"), "retained paid packets must match actual finalized transactions");
        assert.equal(report.paidResumptionAllowed, false); assert.equal(report.historyCompleteness, "not-established");
        assert.equal(restored.spent(), chargedBefore); assert.equal(restored.inspect(target).unsettled, 0n);
        assert.equal(await historyConnection.getBalance(payer.publicKey, "finalized"), paidBefore);
        assert.throws(() => restored.claim(retained.records[0]!.id, retained.records[0]!.digest), /forbids/);
        const nextKey = randomBytes(32);
        try {
          restored.rotateKey(nextKey);
          assert.equal(restored.instanceId, journalId);
          assert.throws(() => RelayerJournal.openForMaintenance(file, key, scope));
          assert.throws(() => new RelayerJournal(file, nextKey, scope), /restored/);
        } finally { nextKey.fill(0); }
        console.log("✓ older relayer backup reconciled exact finalized packets without a payer key or debit; missing later work remains quarantined after key rotation");
      } finally { restored.close(); }
    },
    arm() { armed = true; hidden = false; packets.length = 0; },
    async restart() { await stop(); hidden = false; journal = RelayerJournal.openExisting(path, key, scope, journalId); server = buildServer({ connection: transport, payer, journal, minWalletLamports: 1n }); return listen(); },
    spent: () => journal.spent(),
    assertSinglePacket() { assert.equal(new Set(packets).size, 1); },
    async close() { await stop(); key.fill(0); rmSync(dir, { recursive: true, force: true }); },
  };
}
