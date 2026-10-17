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
