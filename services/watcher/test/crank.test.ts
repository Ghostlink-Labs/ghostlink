import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { CrankJournal } from "../src/journal.js";
import { world } from "./fixture.js";

const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.reverse()) fn(); clean.length = 0; vi.restoreAllMocks(); });
const setup = (budget?: number) => { const w = world(budget); clean.push(w.cleanup); return w; };

describe("durable funded watcher", () => {
  it.each(["ack", "error"])("reuses one packet and charge after %s and watcher restart", async mode => {
    const w = setup(), j = w.open(), original = w.watcher(j), marker = "SYNTHETIC_CRANK_SECRET";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    w.chain.sendRawTransaction.mockImplementation(async () => { if (mode === "error") throw new Error(marker); return bs58.encode(new Uint8Array(64).fill(8)); });
    await original.tick(); const saved = j.get(w.pocket.toBase58())!;
    expect(saved.state).toBe("pending"); expect(w.chain.confirmTransaction).not.toHaveBeenCalled();
    j.close(); const reopened = w.open(), restored = w.watcher(reopened);
    await restored.tick();
    w.chain.sendRawTransaction.mockImplementation(async bytes => bs58.encode(Transaction.from(bytes).signature!));
    await restored.tick();
    expect(new Set(w.chain.sendRawTransaction.mock.calls.map(call => Buffer.from(call[0]).toString("base64"))).size).toBe(1);
    expect(w.chain.getLatestBlockhashAndContext).toHaveBeenCalledOnce();
    expect(reopened.spent()).toBe(5000); expect(reopened.get(w.pocket.toBase58())?.state).toBe("confirmed");
    expect(restored.pending.size).toBe(1); // Only the actual execution event clears pending/notifies.
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
    expect(readFileSync(w.path).includes(saved.packet.rawBase64)).toBe(false);
  });

  it("commits before broadcast and recovers after a real child exits at that boundary", async () => {
    const w = setup(), j = w.open();
    // Obtain a valid packet, then use a separate child-owned journal for the crash boundary.
    await w.cranker(j).execute(w.pocket.toBase58());
    const record = j.get(w.pocket.toBase58())!, childPath = join(w.directory, "child.sqlite"), fixture = join(w.directory, "fixture.json");
    writeFileSync(fixture, JSON.stringify({ scope: w.scope, key: w.key.toString("hex"), record }));
    const module = pathToFileURL(join(process.cwd(), "dist/journal.js")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs'; import { CrankJournal } from ${JSON.stringify(module)};
      const f = JSON.parse(readFileSync(process.argv[1])); const j = new CrankJournal(process.argv[2], Buffer.from(f.key,'hex'), f.scope,
        {maximumFeeLamports:10000,totalBudgetLamports:20000});
      j.prepare(f.record.pocket,f.record.proposal,f.record.packet,5000); process.exit(23);
    `, fixture, childPath], { timeout: 5000, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(23);
    const reopened = new CrankJournal(childPath, w.key, w.scope, { maximumFeeLamports: 10_000, totalBudgetLamports: 20_000 });
    clean.push(() => reopened.close());
    w.status(null); w.chain.sendRawTransaction.mockClear();
    await w.cranker(reopened).execute(w.pocket.toBase58());
    expect(Buffer.from(w.chain.sendRawTransaction.mock.calls[0]![0]).toString("base64")).toBe(record.packet.rawBase64);
    expect(reopened.spent()).toBe(5000);
  });

  it("atomically shares one packet and budget across competing journal handles", async () => {
    const w = setup(), a = w.open(), b = w.open();
    w.chain.confirmTransaction.mockRejectedValue(new Error("uncertain"));
    await Promise.allSettled([w.cranker(a).execute(w.pocket.toBase58()), w.cranker(b).execute(w.pocket.toBase58())]);
    expect(a.spent()).toBe(5000); expect(a.get(w.pocket.toBase58())?.packet).toEqual(b.get(w.pocket.toBase58())?.packet);
    expect(w.chain.sendRawTransaction.mock.calls.length).toBeGreaterThan(0);
    expect(new Set(w.chain.sendRawTransaction.mock.calls.map(call => Buffer.from(call[0]).toString("base64"))).size).toBe(1);
  });

  it("refuses a validly signed journal packet containing any instruction other than the expected crank", async () => {
    const w = setup(), j = w.open(), blockhash = Keypair.generate().publicKey.toBase58();
    const tx = new Transaction({ feePayer: w.payer.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: w.payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    tx.sign(w.payer);
    j.prepare(w.pocket.toBase58(), "synthetic", { rawBase64: tx.serialize().toString("base64"), signature: bs58.encode(tx.signature!),
      blockhash, minContextSlot: 101, lastValidBlockHeight: 200 }, 5000);
    await expect(w.cranker(j).execute(w.pocket.toBase58())).rejects.toThrow(/identity mismatch/);
    expect(w.chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("drains the active tick without admitting new funded work", async () => {
    const w = setup(), watcher = w.watcher();
    let complete!: () => void;
    w.chain.confirmTransaction.mockImplementationOnce(() => new Promise(resolve => {
      complete = () => resolve({ value: { err: null }, context: { slot: 101 } });
    }));
    const active = watcher.tick();
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    watcher.drain(); expect(watcher.idle).toBe(false);
    await watcher.tick(); complete(); await active;
    expect(watcher.idle).toBe(true); await watcher.tick();
    expect(w.chain.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("reserves again only after finalized expiry with the same pending proposal; cap survives restart", async () => {
    const w = setup(10_000), j = w.open();
    w.chain.sendRawTransaction.mockRejectedValue(new Error("lost"));
    await expect(w.cranker(j).execute(w.pocket.toBase58())).rejects.toThrow();
    const first = j.get(w.pocket.toBase58())!;
    w.expire(); await expect(w.cranker(j).execute(w.pocket.toBase58())).rejects.toThrow();
    expect(j.get(w.pocket.toBase58())!.packet.signature).not.toBe(first.packet.signature); expect(j.spent()).toBe(10_000);
    j.close(); const reopened = w.open();
    w.chain.getBlockHeight.mockResolvedValue(1000); w.slot(1200);
    await expect(w.cranker(reopened).execute(w.pocket.toBase58())).rejects.toThrow(/budget/);
    expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(2); expect(reopened.spent()).toBe(10_000);
  });

  it("refuses replacement when expired signature history is missing and the proposal changed", async () => {
    const w = setup(), j = w.open();
    w.chain.sendRawTransaction.mockRejectedValue(new Error("lost"));
    await expect(w.cranker(j).execute(w.pocket.toBase58())).rejects.toThrow();
    w.expire(); w.after(200n);
    await expect(w.cranker(j).execute(w.pocket.toBase58())).rejects.toThrow(/outcome unavailable/);
    expect(w.chain.sendRawTransaction).toHaveBeenCalledOnce(); expect(j.spent()).toBe(5000);
  });

  it("refuses wrong genesis/payer, stale RPC and invalid or excessive fees before sending", async () => {
    const w = setup(), j = w.open();
    expect(() => new CrankJournal(w.path, w.key, { ...w.scope, payer: Keypair.generate().publicKey.toBase58() }, { maximumFeeLamports: 1, totalBudgetLamports: 1 })).toThrow();
    w.chain.getGenesisHash.mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());
    await expect(w.cranker(j).execute(w.pocket.toBase58())).rejects.toThrow(/genesis/);
    for (const fee of [null, 10_001, -1, NaN]) {
      w.chain.getFeeForMessage.mockResolvedValueOnce({ context: { slot: 101 }, value: fee });
      await expect(w.cranker(j).execute(w.pocket.toBase58())).rejects.toThrow();
    }
    w.chain.getAccountInfoAndContext.mockResolvedValueOnce({ context: { slot: 0 }, value: null! });
    await expect(w.cranker(j).execute(w.pocket.toBase58())).rejects.toThrow(/stale/);
    expect(w.chain.sendRawTransaction).not.toHaveBeenCalled(); expect(j.spent()).toBe(0);
  });

  it("does not broadcast after journal persistence fails or confirmation was already observed", async () => {
    const w = setup(), j = w.open();
    const fault = new DatabaseSync(w.path);
    fault.exec("CREATE TRIGGER fail_crank BEFORE INSERT ON cranks BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(w.cranker(j).execute(w.pocket.toBase58())).rejects.toThrow(/disk full/);
    expect(w.chain.sendRawTransaction).not.toHaveBeenCalled(); expect(j.spent()).toBe(0);
    fault.exec("DROP TRIGGER fail_crank"); fault.close();
    await w.cranker(j).execute(w.pocket.toBase58());
    w.status(null); await w.cranker(j).execute(w.pocket.toBase58());
    expect(j.get(w.pocket.toBase58())?.state).toBe("confirmed"); expect(w.chain.sendRawTransaction).toHaveBeenCalledOnce();
    w.status({ slot: 101, confirmations: null, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" });
    await w.cranker(j).execute(w.pocket.toBase58()); await w.cranker(j).execute(w.pocket.toBase58());
    expect(j.get(w.pocket.toBase58())?.state).toBe("failed"); expect(w.chain.sendRawTransaction).toHaveBeenCalledOnce();
  });
});
