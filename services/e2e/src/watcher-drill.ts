import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readPocketAccount } from "@ghostlink/service-kit";
import { Watcher } from "@ghostlink/watcher";
import { startRpcFaultFixture } from "./rpc-fault.js";
import { watcherGenesis } from "./watcher-fixture.js";

export async function exerciseWatcher(input: {
  connection: Connection; payer: Keypair; pocket: PublicKey; relayerUrl: string;
  ownerBody: (action: "propose" | "cancel" | "revoke", change?: Uint8Array) => Promise<Record<string, unknown>>;
}) {
  const { connection, payer, pocket, relayerUrl, ownerBody } = input;
  const directory = mkdtempSync(join(tmpdir(), "ghostlink-watcher-validator-")), state = join(directory, "state.json");
  const rpc = await startRpcFaultFixture(connection), genesis = await connection.getGenesisHash();
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
  const restore = () => new Watcher(rpc.connection, { notify }, 1_000_000_000n, payer, state, genesis);
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
    await watcher.tick(); rpc.assertRecovered();
    const executed = await read(mature.pocket);
    assert(executed.home.equals(mature.newHome)); assert.equal(executed.pending, undefined);
    assert.equal(executed.ownerActionNonce, 1n);
    assert((await read(future.pocket)).home.equals(future.home));
    assert.equal(watcher.pending.size, 1);
    await assert.rejects(() => watcher.tick()); assert.equal(failedDeliveries, 3);
    assert.equal(delivered.filter(item => item.pocket === mature.pocket.toBase58()).length, 0);
    outage = false; watcher = restore(); await watcher.tick();
    assert.equal(delivered.filter(item => item.pocket === mature.pocket.toBase58() && String(item.subject).includes("executed")).length, 1);
    console.log("✓ watcher executed a mature genesis fixture through identical-packet failover; future timelock untouched; receiver outage retried after restart");

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
  } finally { await rpc.close(); rmSync(directory, { recursive: true, force: true }); }
}
