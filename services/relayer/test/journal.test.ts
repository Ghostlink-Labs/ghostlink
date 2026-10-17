import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import { RelayerJournal } from "../src/journal.js";
import { RelayerSubmission, requestIdentity } from "../src/submission.js";
import { reconcileRetainedRelayerOperations } from "../src/reconciliation.js";
import { buildServer } from "../src/server.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.reverse()) fn(); cleanup.length = 0; });
function world() {
  const dir = mkdtempSync(join(tmpdir(), "relayer-journal-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "journal.db"), key = randomBytes(32), payer = Keypair.generate();
  const scope = { genesisHash: Keypair.generate().publicKey.toBase58(), payer: payer.publicKey.toBase58(), pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() };
  const open = (file = path, budget = 100000n) => { const j = new RelayerJournal(file, key, scope, budget); cleanup.push(() => j.close()); return j; };
  const chain = {
    getBalanceAndContext: vi.fn(async () => ({ context: { slot: 50 }, value: 1_000_000_000 })),
    getGenesisHash: vi.fn(async () => scope.genesisHash),
    getSignatureStatuses: vi.fn(async () => ({ context: { slot: 50 }, value: [null] as any[] })),
    getBlockHeight: vi.fn(async () => 50),
    sendRawTransaction: vi.fn(async (bytes: Uint8Array) => { throw new Error("SYNTHETIC_LOST_REPLY"); return bs58.encode(Transaction.from(bytes).signature!); }),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
  };
  const make = vi.fn(async () => {
    const extra = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58();
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight: 100 })
      .add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: extra.publicKey, lamports: 100, space: 0, programId: SystemProgram.programId }));
    tx.sign(payer, extra);
    return { rawBase64: tx.serialize().toString("base64"), signature: bs58.encode(tx.signature!), blockhash, lastValidBlockHeight: 100, minContextSlot: 50, feeLamports: "10000", rentLamports: "100",
      tokenPairs: [{ source: payer.publicKey.toBase58(), destination: extra.publicKey.toBase58(), mint: SystemProgram.programId.toBase58() }] };
  });
  return { dir, path, key, scope, open, chain, make, submit: (j: RelayerJournal) => new RelayerSubmission(chain as unknown as Connection, j) };
}
const id = "01".repeat(32), digest = "02".repeat(32);
const transactionHistory = (packet: Awaited<ReturnType<ReturnType<typeof world>["make"]>>) => {
  const tx = Transaction.from(Buffer.from(packet.rawBase64, "base64"));
  return { slot: 60, transaction: { message: tx.compileMessage(), signatures: tx.signatures.map(s => bs58.encode(s.signature!)) },
    meta: { err: null, fee: 10000 } };
};

describe("relayer backup quarantine and retained-history reconciliation", () => {
  it("restores an old encrypted snapshot without enabling any paid submission", async () => {
    const w = world(), live = w.open(), archive = join(w.dir, "backup.enc");
    await w.submit(live).submit(id, digest, w.make);
    await live.backupTo(archive);
    const newer = "03".repeat(32);
    await w.submit(live).submit(newer, digest, w.make);
    const restored = RelayerJournal.restoreBackup(archive, join(w.dir, "restored"), w.key, w.scope);
    expect(() => w.open(restored)).toThrow(/restored/);
    const audit = RelayerJournal.openForMaintenance(restored, w.key, w.scope); cleanup.push(() => audit.close());
    expect(audit.get(id)).toEqual(live.get(id)); expect(audit.get(newer)).toBeUndefined();
    expect(audit.spent()).toBe(10100n); expect(live.spent()).toBe(20200n);
    expect(audit.recoveryId).toMatch(/^[0-9a-f]{64}$/);
    w.chain.sendRawTransaction.mockClear(); w.make.mockClear(); w.chain.getGenesisHash.mockClear();
    for (const requestId of [id, newer]) await expect(w.submit(audit).submit(requestId, digest, w.make)).rejects.toThrow(/forbids/);
    expect(() => audit.claim(id, digest)).toThrow(/forbids/);
    expect(() => audit.prepare(id, "stale-lease", live.get(id)!.packet!, { balanceLamports: 999999999n, slot: 100, minimumReserveLamports: 0n })).toThrow(/forbids/);
    expect(() => audit.release(id, "stale-lease")).toThrow(/forbids/);
    expect(() => buildServer({ connection: w.chain as unknown as Connection, payer: Keypair.generate(), journal: audit })).toThrow(/forbids/);
    expect(w.chain.sendRawTransaction).not.toHaveBeenCalled(); expect(w.chain.getGenesisHash).not.toHaveBeenCalled(); expect(w.make).not.toHaveBeenCalled();
    expect(readFileSync(archive).includes(live.get(id)!.packet!.rawBase64)).toBe(false);
    expect(() => RelayerJournal.restoreBackup(archive, join(w.dir, "wrong-key"), randomBytes(32), w.scope)).toThrow();
    expect(() => RelayerJournal.restoreBackup(archive, join(w.dir, "wrong-scope"), w.key, { ...w.scope, genesisHash: Keypair.generate().publicKey.toBase58() })).toThrow();
  });

  it("independently verifies exact finalized packets but never certifies snapshot completeness or resumes payment", async () => {
    const w = world(), j = w.open(); await w.submit(j).submit(id, digest, w.make);
    const archive = join(w.dir, "backup.enc"); await j.backupTo(archive);
    const file = RelayerJournal.restoreBackup(archive, join(w.dir, "restore"), w.key, w.scope);
    const audit = RelayerJournal.openForMaintenance(file, w.key, w.scope); cleanup.push(() => audit.close());
    const history = transactionHistory(j.get(id)!.packet!);
    const chain = { ...w.chain, getSlot: vi.fn(async () => 100), getTransaction: vi.fn(async () => history) };
    chain.sendRawTransaction.mockClear();
    const report = await reconcileRetainedRelayerOperations(chain as unknown as Connection, audit);
    expect(report).toMatchObject({ entries: [{ requestIdHex: id, outcome: "verified-finalized", slot: 60 }],
      historyCompleteness: "not-established", paidResumptionAllowed: false });
    expect(audit.inspect(100)).toMatchObject({ spent: 10100n, unsettled: 0n });
    expect(audit.get(id)!.packet).toEqual(j.get(id)!.packet);
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    expect(() => w.open(file)).toThrow(/restored/);
    const next = randomBytes(32); audit.rotateKey(next);
    expect(() => RelayerJournal.openForMaintenance(file, w.key, w.scope)).toThrow();
    expect(() => new RelayerJournal(file, next, w.scope)).toThrow(/restored/);
    const archive2 = join(w.dir, "backup2.enc"); await audit.backupTo(archive2);
    const second = RelayerJournal.openForMaintenance(RelayerJournal.restoreBackup(archive2, join(w.dir, "restore2"), next, w.scope), next, w.scope);
    cleanup.push(() => second.close()); expect(second.recoveryId).not.toBe(audit.recoveryId);
    expect(second.get(id)).toEqual(audit.get(id)); expect(() => second.claim(id, digest)).toThrow(/forbids/);
  });

  it("keeps missing, substituted, conflicting and stale history unresolved without releasing funds", async () => {
    const w = world(), j = w.open(); await w.submit(j).submit(id, digest, w.make);
    const packet = j.get(id)!.packet!, good = transactionHistory(packet);
    const getTransaction = vi.fn(async (): Promise<any> => null);
    const chain = { ...w.chain, getSlot: vi.fn(async () => 100), getTransaction };
    for (const [response, outcome] of [
      [null, "unresolved"], [transactionHistory(await w.make()), "conflict"],
      [{ ...good, slot: 101 }, "conflict"], [{ ...good, meta: { err: null, fee: 10001 } }, "conflict"],
    ] as const) {
      getTransaction.mockResolvedValueOnce(response);
      expect((await reconcileRetainedRelayerOperations(chain as unknown as Connection, j)).entries[0]!.outcome).toBe(outcome);
      expect(j.inspect(100).unsettled).toBe(10100n);
    }
    getTransaction.mockRejectedValueOnce(new Error("synthetic private RPC URL and credential"));
    expect(JSON.stringify(await reconcileRetainedRelayerOperations(chain as unknown as Connection, j))).not.toContain("credential");
    chain.getSlot.mockResolvedValueOnce(49);
    await expect(reconcileRetainedRelayerOperations(chain as unknown as Connection, j)).rejects.toThrow(/stale/);
    chain.getGenesisHash.mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());
    await expect(reconcileRetainedRelayerOperations(chain as unknown as Connection, j)).rejects.toThrow(/chain mismatch/);
    getTransaction.mockResolvedValueOnce(good); await reconcileRetainedRelayerOperations(chain as unknown as Connection, j);
    getTransaction.mockResolvedValueOnce({ ...good, meta: { err: { InstructionError: [0, "InvalidArgument"] }, fee: 10000 } });
    expect((await reconcileRetainedRelayerOperations(chain as unknown as Connection, j)).entries[0]!.reason).toBe("saved_finality_mismatch");
    expect(j.get(id)!.observation.state).toBe("finalized");
  });

  it("pages authenticated records and bounds concurrent history requests", async () => {
    const w = world(), j = w.open(), packets = new Map<string, ReturnType<typeof transactionHistory>>();
    for (let i = 1; i <= 8; i++) {
      const recordId = i.toString(16).padStart(64, "0"); await w.submit(j).submit(recordId, digest, w.make);
      const packet = j.get(recordId)!.packet!; packets.set(packet.signature, transactionHistory(packet));
    }
    const first = j.page(undefined, 3), second = j.page(first.nextCursor, 3), third = j.page(second.nextCursor, 3);
    expect([...first.records, ...second.records, ...third.records]).toHaveLength(8); expect(third.nextCursor).toBeUndefined();
    expect(() => j.page("bad")).toThrow(); expect(() => j.page(undefined, 101)).toThrow();
    let active = 0, maximum = 0;
    const chain = { ...w.chain, getSlot: async () => 100, getTransaction: async (signature: string) => {
      active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return packets.get(signature)!;
    } };
    const report = await reconcileRetainedRelayerOperations(chain as unknown as Connection, j);
    expect(maximum).toBe(4); expect(report.entries.every(e => e.outcome === "verified-finalized")).toBe(true);
  });

  it("runs the actual operator backup/restore/inspect/rotate commands without a payer key", async () => {
    const w = world(), j = w.open(); await w.submit(j).submit(id, digest, w.make);
    const scopeFile = join(w.dir, "scope.json"), keyFile = join(w.dir, "key"), nextFile = join(w.dir, "next-key");
    writeFileSync(scopeFile, JSON.stringify(w.scope)); writeFileSync(keyFile, w.key); writeFileSync(nextFile, randomBytes(32));
    const cli = (args: string[], path = w.path, storageKey = keyFile) => spawnSync(process.execPath, [join(process.cwd(), "dist/maintenance.js"), ...args], {
      encoding: "utf8", timeout: 10000, env: { ...process.env, GHOSTLINK_RELAYER_KEYPAIR: "", RELAYER_JOURNAL_PATH: path,
        RELAYER_JOURNAL_KEY_PATH: storageKey, RELAYER_MAINTENANCE_SCOPE_PATH: scopeFile },
    });
    const archive = join(w.dir, "cli.enc"), restored = join(w.dir, "cli-restored"), output = join(w.dir, "report.json");
    for (const args of [["backup", archive], ["restore", archive, restored]]) {
      const result = cli(args); expect(result.status, result.stderr).toBe(0);
    }
    const file = join(restored, "state.sqlite");
    expect(cli(["inspect", output], file).status).toBe(0);
    const report = JSON.parse(readFileSync(output, "utf8")); expect(report.records[0].receipt.signature).toBe(j.get(id)!.packet!.signature);
    expect(report.paidResumptionAllowed).toBe(false); expect(readFileSync(output, "utf8")).not.toContain(j.get(id)!.packet!.rawBase64);
    expect(cli(["inspect", output], file).status).toBe(1); // Never overwrite an earlier report.
    const stale = RelayerJournal.openForMaintenance(file, w.key, w.scope); cleanup.push(() => stale.close());
    expect(cli(["rotate", nextFile], file).status).toBe(0);
    expect(() => stale.get(id)).toThrow();
    expect(cli(["inspect", join(w.dir, "new-report.json")], file, nextFile).status).toBe(0);
  });
});

describe("durable relayer submissions", () => {
  it("resumes identical signed bytes and auxiliary destinations after restart, then reconciles without another send", async () => {
    const w = world(), a = w.open();
    const first = await w.submit(a).submit(id, digest, w.make); a.close();
    const b = w.open(); const next = await w.submit(b).submit(id, digest, w.make);
    expect(next).toEqual(first); expect(w.make).toHaveBeenCalledOnce(); expect(b.spent()).toBe(10100n);
    expect(new Set(w.chain.sendRawTransaction.mock.calls.map(c => Buffer.from(c[0]).toString("base64"))).size).toBe(1);
    w.chain.getSignatureStatuses.mockResolvedValue({ context: { slot: 52 }, value: [{ slot: 51, confirmationStatus: "finalized", err: null }] });
    expect((await w.submit(b).submit(id, digest, w.make)).state).toBe("finalized");
    expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(readFileSync(w.path).includes(first.signature!)).toBe(false);
  });
  it("recovers the committed packet after a child exits before broadcasting", async () => {
    const w = world(), packet = await w.make(), fixture = join(w.dir, "fixture.json");
    writeFileSync(fixture, JSON.stringify({ scope: w.scope, key: w.key.toString("hex"), packet }));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {readFileSync} from 'node:fs'; import {RelayerJournal} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/journal.js")).href)};
      const f=JSON.parse(readFileSync(process.argv[1])); const j=new RelayerJournal(process.argv[2],Buffer.from(f.key,'hex'),f.scope);
      const c=j.claim('${id}','${digest}'); j.prepare('${id}',c.token,f.packet,{balanceLamports:1000000000n,slot:50,minimumReserveLamports:50000000n}); process.exit(23);
    `, fixture, w.path], { encoding: "utf8", timeout: 5000 });
    expect(child.status, child.stderr).toBe(23);
    const j = w.open(); w.make.mockClear(); await w.submit(j).submit(id, digest, w.make);
    expect(w.make).not.toHaveBeenCalled(); expect(j.spent()).toBe(10100n);
    expect(Buffer.from(w.chain.sendRawTransaction.mock.calls[0]![0]).toString("base64")).toBe(packet.rawBase64);
  });
  it("rolls back packet and charge together on a real SQLite commit failure", async () => {
    const w = world(), j = w.open(), fault = new DatabaseSync(w.path); cleanup.push(() => fault.close());
    fault.exec("CREATE TRIGGER fail_packet BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'disk full'); END");
    await expect(w.submit(j).submit(id, digest, w.make)).rejects.toThrow();
    expect(j.spent()).toBe(0n); expect(j.get(id)).toBeUndefined(); expect(w.chain.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("coordinates competing handles and refuses reused IDs with changed content", async () => {
    const w = world(), a = w.open(), b = w.open();
    await Promise.all([w.submit(a).submit(id, digest, w.make), w.submit(b).submit(id, digest, w.make)]);
    expect(w.make).toHaveBeenCalledOnce(); expect(a.spent()).toBe(10100n);
    await expect(w.submit(b).submit(id, "03".repeat(32), w.make)).rejects.toMatchObject({ status: 409 });
  });
  it("atomically reserves shared payer liquidity and only releases it after a covered finalized receipt", async () => {
    const w = world(), a = w.open(), b = w.open();
    w.chain.getBalanceAndContext.mockResolvedValue({ context: { slot: 50 }, value: 50_010_100 });
    const other = "03".repeat(32);
    const results = await Promise.allSettled([w.submit(a).submit(id, digest, w.make), w.submit(b).submit(other, digest, w.make)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 503 } });
    expect(a.spent()).toBe(10100n); expect(w.chain.sendRawTransaction).toHaveBeenCalledOnce();
    const winner = a.get(id)?.packet ? id : other, loser = winner === id ? other : id;
    expect(a.inspect(50).unsettled).toBe(10100n);
    expect(a.inspect(50, Date.now() + 86_400_001)).toMatchObject({ spent: 0n, unsettled: 10100n });
    w.chain.getSignatureStatuses.mockResolvedValue({ context: { slot: 52 }, value: [{ slot: 51, confirmationStatus: "confirmed", err: null }] });
    await w.submit(a).status(winner);
    expect(a.inspect(52).unsettled).toBe(10100n);
    w.chain.getSignatureStatuses.mockResolvedValue({ context: { slot: 53 }, value: [{ slot: 51, confirmationStatus: "finalized", err: null }] });
    await w.submit(a).status(winner);
    expect(a.inspect(50).unsettled).toBe(10100n);
    expect(a.inspect(51).unsettled).toBe(0n);
    await expect(w.submit(b).submit(loser, digest, w.make)).rejects.toMatchObject({ status: 503 });
    w.chain.getBalanceAndContext.mockResolvedValue({ context: { slot: 53 }, value: 50_010_100 });
    w.chain.getSignatureStatuses.mockResolvedValue({ context: { slot: 53 }, value: [null] });
    await w.submit(b).submit(loser, digest, w.make);
    expect(a.spent()).toBe(20200n); // Finality releases liquidity, never the 24-hour spending reservation.
  });
  it("refuses a stale or invalid payer balance before committing or broadcasting", async () => {
    const w = world(), j = w.open();
    for (const balance of [{ context: { slot: 49 }, value: 1_000_000_000 }, { context: { slot: 50 }, value: NaN }]) {
      w.chain.getBalanceAndContext.mockResolvedValueOnce(balance);
      await expect(w.submit(j).submit(id, digest, w.make)).rejects.toThrow();
      expect(j.get(id)).toBeUndefined(); expect(j.spent()).toBe(0n);
    }
    expect(w.chain.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("does not replace expired, stale, wrong-chain or failed operations", async () => {
    const w = world(), j = w.open(), service = w.submit(j);
    await service.submit(id, digest, w.make); w.chain.sendRawTransaction.mockClear();
    w.chain.getBlockHeight.mockResolvedValue(101);
    expect((await service.submit(id, digest, w.make)).reason).toBe("blockhash_expired_outcome_unavailable");
    w.chain.getSignatureStatuses.mockResolvedValue({ context: { slot: 49 }, value: [null] });
    expect((await service.submit(id, digest, w.make)).state).toBe("unknown");
    w.chain.getSignatureStatuses.mockResolvedValue({ context: { slot: 51 }, value: [{ slot: 50, confirmationStatus: "confirmed", err: { InstructionError: [0, "SYNTHETIC_SECRET"] } }] });
    expect(await service.submit(id, digest, w.make)).toMatchObject({ state: "failed" });
    expect(JSON.stringify(await service.status(id))).not.toContain("SYNTHETIC_SECRET");
    w.chain.getGenesisHash.mockResolvedValue(Keypair.generate().publicKey.toBase58());
    await expect(service.submit(id, digest, w.make)).rejects.toThrow("chain mismatch");
    expect(w.chain.sendRawTransaction).not.toHaveBeenCalled(); expect(w.make).toHaveBeenCalledOnce();
  });
  it("requires a fresh observation ID for snapshots, while canonical retries keep their identity", () => {
    const body = { wallet: "wallet", holding: "holding" };
    expect(() => requestIdentity("/snapshot", body)).toThrow("snapshot requires");
    expect(requestIdentity("/snapshot", { requestIdHex: id, ...body })).toEqual(requestIdentity("/snapshot", { holding: "holding", wallet: "wallet", requestIdHex: id }));
    expect(requestIdentity("/snapshot", { ...body, requestIdHex: digest }).id).not.toBe(id);
  });
});
