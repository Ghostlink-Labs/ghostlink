import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { POCKET, readPocketAccount } from "@ghostlink/service-kit";
import { CrankJournal, Watcher } from "@ghostlink/watcher";
import { startRpcFaultFixture } from "./rpc-fault.js";
import { watcherGenesis } from "./watcher-fixture.js";

export async function exerciseWatcher(input: {
  connection: Connection; payer: Keypair; pocket: PublicKey; relayerUrl: string;
  ownerBody: (action: "propose" | "cancel" | "revoke", change?: Uint8Array) => Promise<Record<string, unknown>>;
}) {
  const { connection, payer, pocket, relayerUrl, ownerBody } = input;
  const directory = mkdtempSync(join(tmpdir(), "ghostlink-watcher-validator-")), state = join(directory, "state.json");
  const rpc = await startRpcFaultFixture(connection), genesis = await connection.getGenesisHash();
  const journalKey = randomBytes(32), journalPath = join(directory, "cranks.sqlite");
  let journal: CrankJournal | undefined, broadcasts = 0;
  // The provider pool resends identical bytes; then lose the final reply at the process boundary too.
  const crankConnection = new Proxy(rpc.connection, { get(target, property) {
    if (property === "sendRawTransaction") return async (...args: Parameters<Connection["sendRawTransaction"]>) => {
      broadcasts++; const signature = await target.sendRawTransaction(...args);
      if (broadcasts === 1) throw new Error("synthetic accepted-send response lost before watcher restart");
      return signature;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const fixtures = watcherGenesis(), mature = fixtures[0]!, future = fixtures[1]!;
  const read = async (address: PublicKey) => {
    const info = await connection.getAccountInfo(address, "confirmed"); assert(info); return readPocketAccount(info);
  };
  let failedDeliveries = 0, outage = true;
  const delivered: Record<string, unknown>[] = [];
  const notify = async (subject: string, body: Record<string, unknown>) => {
    if (outage && subject.includes("executed")) { failedDeliveries++; throw new Error("synthetic receiver outage"); }
    delivered.push({ ...body, subject });
  };
  const restore = () => {
    journal?.close();
    journal = new CrankJournal(journalPath, journalKey, { genesisHash: genesis, pocketProgram: POCKET.toBase58(), payer: payer.publicKey.toBase58() },
      { maximumFeeLamports: 20_000, totalBudgetLamports: 100_000 });
    return new Watcher(crankConnection, { notify }, 1_000_000_000n, payer, state, genesis, journal);
  };
  const action = async (kind: "propose" | "cancel" | "revoke", change?: Uint8Array) => {
    const response = await fetch(`${relayerUrl}/owner-action`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(await ownerBody(kind, change)) });
    assert(response.ok, `watcher fixture owner action failed: ${await response.text()}`);
  };
  try {
    assert.equal((await read(mature.pocket)).pending?.executableAfterSlot, 0n);
    assert((await read(future.pocket)).pending!.executableAfterSlot > BigInt(await connection.getSlot("confirmed")));
    let watcher = restore();
    // These two proposals are explicit genesis fixtures, not fabricated RPC events or production owner approvals.
    watcher.pending.observe(fixtures.map(fixture => ({ kind: "ChangeProposed", pocket: fixture.pocket.toBase58(), executableAfterSlot: fixture.after })));
    rpc.arm();
    const balanceBefore = await connection.getBalance(payer.publicKey, "confirmed");
    await watcher.tick();
    const prepared = journal!.get(mature.pocket.toBase58())!;
    assert.equal(prepared.state, "pending"); assert.equal(broadcasts, 1);
    await connection.confirmTransaction({ signature: prepared.packet.signature, blockhash: prepared.packet.blockhash,
      lastValidBlockHeight: prepared.packet.lastValidBlockHeight }, "confirmed");
    const executed = await read(mature.pocket);
    assert(executed.home.equals(mature.newHome)); assert.equal(executed.pending, undefined);
    assert.equal(executed.ownerActionNonce, 1n);
    assert((await read(future.pocket)).home.equals(future.home));
    assert.equal(watcher.pending.size, 2); // Saved packet is not an execution notification.
    watcher = restore();
    await assert.rejects(() => watcher.tick()); assert.equal(failedDeliveries, 3);
    assert.equal(delivered.filter(item => item.pocket === mature.pocket.toBase58()).length, 0);
    outage = false; watcher = restore(); await watcher.tick();
    rpc.assertRecovered();
    assert.equal(broadcasts, 1, "restart must reconcile accepted packet without another paid attempt");
    assert.equal(journal!.get(mature.pocket.toBase58())!.packet.signature, prepared.packet.signature);
    assert.equal(journal!.spent(), balanceBefore - await connection.getBalance(payer.publicKey, "confirmed"));
    assert.equal(watcher.pending.size, 1);
    assert.equal(delivered.filter(item => item.pocket === mature.pocket.toBase58() && String(item.subject).includes("executed")).length, 1);
    console.log("✓ watcher recovered its durably reserved packet after lost acceptance and restart, reconciled one actual fee, preserved the future timelock and retried receiver delivery");

    // Real owner-authorized proposal/revocation/cancellation on the ordinary E2E pocket.
    const homeBefore = (await read(pocket)).home;
    const change = Buffer.concat([Buffer.from([0]), Keypair.generate().publicKey.toBuffer()]);
    await action("propose", change); await watcher.tick();
    assert(watcher.pending.snapshot().some(([key]) => key === pocket.toBase58()));
    assert((await read(pocket)).pending!.executableAfterSlot > BigInt(await connection.getSlot("confirmed")));
    assert(delivered.some(item => item.pocket === pocket.toBase58() && String(item.subject).includes("proposed")));
    await action("revoke"); await watcher.tick();
    assert((await read(pocket)).pending, "revocation must not pretend to cancel a separate pending change");
    await action("cancel", change); watcher = restore(); await watcher.tick();
    const cancelled = await read(pocket);
    assert.equal(cancelled.pending, undefined); assert(cancelled.home.equals(homeBefore));
    assert.equal(cancelled.sessionExpirySlot, 0n);
    assert(!watcher.pending.snapshot().some(([key]) => key === pocket.toBase58()));
    assert(!delivered.some(item => item.pocket === pocket.toBase58() && String(item.subject).includes("executed")));
    console.log("✓ real owner proposal was observed, revocation stayed separate, and cancellation survived watcher restart without a false execution alert");
  } finally { journal?.close(); journalKey.fill(0); await rpc.close(); rmSync(directory, { recursive: true, force: true }); }
}
