import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PublicKey } from "@solana/web3.js";
import { conservativePolicy } from "@ghostlink/common";
import { BotKeyStore, BotOnboarding, type BotConsent } from "../src/index.js";
import { deployment, initData, NOW, pocketAccount, TOKEN, USER } from "./helpers.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.reverse()) f(); cleanup.length = 0; });
const requestKey = (n: number) => n.toString(16).padStart(32, "0");
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-orders-test-")), path = join(dir, "bot.sqlite"), key = randomBytes(32);
  cleanup.push(() => { key.fill(0); rmSync(dir, { recursive: true, force: true }); });
  const stores: BotKeyStore[] = [];
  cleanup.push(() => { for (const s of stores) s.close(); });
  const open = () => { const s = new BotKeyStore(path, key); stores.push(s); return s; };
  let head = 100, context = 100, nonceBase = 0n, used: bigint[] = [], consent: BotConsent;
  let override: BotConsent | undefined;
  const chain = { getGenesisHash: async () => deployment.genesisHash, getSlot: async () => head,
    getAccountInfoAndContext: vi.fn(async () => ({ context: { slot: context }, value: pocketAccount(override ?? consent, nonceBase, used) })) };
  const options = { botToken: TOKEN, chain, appOrigin: "https://bot.example.com", deployment,
    policy: conservativePolicy(), nowSeconds: () => NOW };
  const manager = (store = open()) => new BotOnboarding({ ...options, store });
  const store = open(), m = manager(store);
  const input = { requestKey: requestKey(1), appId: "23", home: new PublicKey(randomBytes(32)).toBase58(), sessionExpirySlot: "10000" };
  consent = (await m.create(initData(), input)).consent;
  await m.confirm(initData(), consent.id);
  const params = { inMint: new Uint8Array(32).fill(2), inMax: 10n, outMint: new Uint8Array(32).fill(3), outMin: 9n, deadlineSlot: 500n };
  return { dir, path, key, chain, options, manager, store, m, consent, params,
    prepare: (n: number, p = params, target = m) => target.prepareIntent(consent.id, USER, { requestKey: requestKey(n), params: p }),
    bank: (h: number, c = h) => { head = h; context = c; },
    nonces: (base: bigint, values: bigint[] = []) => { nonceBase = base; used = values; },
    override: (c?: BotConsent) => { override = c; } };
}

describe("durable bot orders", () => {
  it("allocates distinct nonces across workers; identical business retries recover exactly the same signed intent", async () => {
    const w = await world(), second = w.manager();
    const [a, retry, b] = await Promise.all([w.prepare(2), w.prepare(2, w.params, second), w.prepare(3, w.params, second)]);
    expect(retry).toEqual(a); expect(new Set([a.intent.nonce, b.intent.nonce]).size).toBe(2);
    expect([a.intent.nonce, b.intent.nonce].sort()).toEqual([0n, 1n]);
    const restarted = w.manager(); expect(await w.prepare(2, w.params, restarted)).toEqual(a);
    await expect(w.prepare(2, { ...w.params, outMin: 8n })).rejects.toThrow(/different parameters/);
    await expect(w.m.prepareIntent(w.consent.id, { ...USER, userId: "43" }, { requestKey: requestKey(2), params: w.params })).rejects.toThrow(/not found/);
    const next = (await w.m.create(initData(), { requestKey: requestKey(9), appId: "24", home: w.consent.home, sessionExpirySlot: "10000" })).consent;
    w.override(next); await w.m.confirm(initData(), next.id);
    await expect(w.m.prepareIntent(next.id, USER, { requestKey: requestKey(2), params: w.params })).rejects.toThrow(/different consent/);
    const status = restarted.orderStatus(w.consent.id, USER, requestKey(2));
    expect(status).toMatchObject({ state: "signed", nonce: "0" }); expect(JSON.stringify(status)).not.toMatch(/signature|inMint/);
  });

  it("recovers both reserved and signed orders after real process exits without closing SQLite", async () => {
    const w = await world();
    for (const [n, crash] of [[2, "before-sign"], [3, "after-save"]] as const) {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { readFileSync } from 'node:fs';
        import { PublicKey } from '@solana/web3.js';
        import { conservativePolicy } from '@ghostlink/common';
        import { BotKeyStore, BotOnboarding } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
        const p = JSON.parse(readFileSync(0, 'utf8'));
        const store = new BotKeyStore(p.path, Buffer.from(p.key, 'hex'));
        if (p.crash === 'before-sign') store.withSeed = async () => process.exit(23);
        const chain = { getGenesisHash: async () => p.consent.deployment.genesisHash, getSlot: async () => 100,
          getAccountInfoAndContext: async () => ({ context: { slot: 100 }, value: { ...p.account,
            owner: new PublicKey(p.account.owner), data: Buffer.from(p.account.data, 'base64') } }) };
        const manager = new BotOnboarding({ botToken: p.token, store, chain, appOrigin: p.consent.appOrigin,
          deployment: p.consent.deployment, policy: conservativePolicy(), nowSeconds: () => p.now });
        await manager.prepareIntent(p.consent.id, p.user, { requestKey: p.requestKey, params: {
          inMint: new Uint8Array(32).fill(2), inMax: 10n, outMint: new Uint8Array(32).fill(3), outMin: 9n, deadlineSlot: 500n } });
        process.exit(23);
      `], { input: JSON.stringify({ path: w.path, key: w.key.toString("hex"), token: TOKEN, now: NOW, user: USER,
        consent: w.consent, requestKey: requestKey(n), crash, account: { ...pocketAccount(w.consent),
          owner: w.consent.deployment.pocketProgram, data: pocketAccount(w.consent).data.toString("base64") } }), encoding: "utf8", timeout: 15_000 });
      expect(child.status, child.stderr).toBe(23);
      expect(w.m.orderStatus(w.consent.id, USER, requestKey(n)).state).toBe(crash === "before-sign" ? "reserved" : "signed");
      const recovered = await w.prepare(n, w.params, w.manager());
      expect(recovered.intent.nonce).toBe(BigInt(n - 2));
      for (const file of readdirSync(w.dir)) {
        const bytes = readFileSync(join(w.dir, file));
        expect(bytes.includes(w.key)).toBe(false);
        expect(bytes.includes(Buffer.from(recovered.signature.signature))).toBe(false);
        expect(bytes.includes(Buffer.from(recovered.signature.signature).toString("hex"))).toBe(false);
      }
    }
  });

  it("refuses cancellation during signing, keeps reservations burned and never leaks a signature before persistence", async () => {
    const w = await world(), original = w.store.withSeed.bind(w.store);
    let release!: () => void;
    const pause = vi.spyOn(w.store, "withSeed").mockImplementation(async (id, bot, user, use) => {
      const signed = await original(id, bot, user, use);
      await new Promise<void>(resolve => { release = resolve; }); return signed;
    });
    const signing = w.prepare(2);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    w.m.cancelOrder(w.consent.id, USER, requestKey(2)); release();
    await expect(signing).rejects.toThrow(/cancelled/); pause.mockRestore();
    await expect(w.prepare(2)).rejects.toThrow(/cancelled/);
    expect((await w.prepare(3)).intent.nonce).toBe(1n);
    const persist = vi.spyOn(w.store, "saveSignedOrder").mockImplementation(() => { throw new Error("disk full"); });
    await expect(w.prepare(4)).rejects.toThrow(/disk full/); persist.mockRestore();
    expect(w.m.orderStatus(w.consent.id, USER, requestKey(4))).toMatchObject({ state: "reserved", nonce: "2" });
    expect((await w.prepare(4)).intent.nonce).toBe(2n);
    w.m.cancel(initData(), w.consent.id);
    await expect(w.prepare(3)).rejects.toThrow(/not active/);
    expect(w.m.orderStatus(w.consent.id, USER, requestKey(3)).state).toBe("signed");
  });

  it("skips the circular bitmap, coordinates explicit nonces and refuses u64 exhaustion", async () => {
    const w = await world(); w.nonces(2047n, [2047n, 2048n]);
    expect((await w.prepare(2)).intent.nonce).toBe(2049n);
    const manual = await w.m.signIntent(w.consent.id, USER, { ...w.params, nonce: 2055n });
    expect(await w.m.signIntent(w.consent.id, USER, { ...w.params, nonce: 2055n })).toEqual(manual);
    await expect(w.m.signIntent(w.consent.id, USER, { ...w.params, nonce: 2055n, outMin: 8n })).rejects.toThrow(/reserved or retired/);
    expect((await w.prepare(3)).intent.nonce).toBe(2056n);
    const last = await world(), max = (1n << 64n) - 1n; last.nonces(max);
    expect((await last.prepare(2)).intent.nonce).toBe(max);
    await expect(last.prepare(3)).rejects.toThrow(/exhausted/);
    const used = await world(); used.nonces(max, [max]);
    await expect(used.prepare(2)).rejects.toThrow(/exhausted/);
  });

  it("applies window backpressure until older signed deadlines pass, including cancelled orders", async () => {
    const w = await world(); await w.prepare(2); w.m.cancelOrder(w.consent.id, USER, requestKey(2));
    await expect(w.m.signIntent(w.consent.id, USER, { ...w.params, nonce: 2048n })).rejects.toThrow(/window is full/);
    w.nonces(2048n); // Another signer advanced the chain: do not silently discard our uncertain order.
    await expect(w.prepare(3)).rejects.toThrow(/window is full/);
    w.bank(501);
    expect((await w.prepare(3, { ...w.params, deadlineSlot: 700n })).intent.nonce).toBe(2048n);
    expect(w.m.orderStatus(w.consent.id, USER, requestKey(2)).state).toBe("cancelled");
  });

  it("pins authorization context across restart and concurrent revocation observations", async () => {
    const w = await world(); w.bank(150); w.override({ ...w.consent, sessionExpirySlot: "0" });
    await expect(w.prepare(2)).rejects.toThrow(/permissions/);
    w.bank(90, 100); w.override();
    await expect(w.prepare(2, w.params, w.manager())).rejects.toThrow(/stale/);
    expect(w.chain.getAccountInfoAndContext).toHaveBeenLastCalledWith(expect.any(PublicKey), { commitment: "confirmed", minContextSlot: 150 });
    w.bank(90, 151); // A lagging head is fine if the actual account response satisfies the durable floor.
    expect((await w.prepare(2)).intent.nonce).toBe(0n);
    const original = w.store.withSeed.bind(w.store);
    const seed = vi.spyOn(w.store, "withSeed").mockImplementation(async (id, bot, user, use) => {
      const signed = await original(id, bot, user, use);
      w.store.observeSlot(w.consent.id, USER.botId, USER.userId, NOW, 200);
      return signed;
    });
    await expect(w.prepare(3)).rejects.toThrow(/stale/); seed.mockRestore();
    expect(w.m.orderStatus(w.consent.id, USER, requestKey(3)).state).toBe("reserved");
    await expect(w.prepare(3)).rejects.toThrow(/stale/);
  });

  it("authenticates order/counter records and preserves the exact parameters through asynchronous caller mutation", async () => {
    const w = await world(); const input = { ...w.params, inMint: w.params.inMint.slice() };
    const pending = w.prepare(2, input); input.inMint.fill(99); input.outMin = 1n;
    const signed = await pending;
    expect(signed.intent.inMint).toEqual(w.params.inMint); expect(signed.intent.outMin).toBe(9n);
    const db = new DatabaseSync(w.path);
    try {
      const record = db.prepare("SELECT record FROM bot_orders LIMIT 1").get()!.record as Uint8Array;
      const corrupt = Buffer.from(record); corrupt[corrupt.length - 1]! ^= 1;
      db.prepare("UPDATE bot_orders SET record=?").run(corrupt);
      await expect(w.prepare(2)).rejects.toThrow();
      db.prepare("UPDATE bot_orders SET record=?").run(record);
      db.exec("UPDATE bot_orders SET nonce='00000000000000000001'");
      expect(() => w.m.orderStatus(w.consent.id, USER, requestKey(2))).toThrow();
      db.exec("UPDATE bot_orders SET nonce='00000000000000000000'");
      const counter = db.prepare("SELECT record FROM bot_counters LIMIT 1").get()!.record as Uint8Array;
      const bad = Buffer.from(counter); bad[0]! ^= 1;
      db.prepare("UPDATE bot_counters SET record=?").run(bad);
      await expect(w.prepare(3)).rejects.toThrow();
      db.exec("DELETE FROM bot_counters"); await expect(w.prepare(3)).rejects.toThrow(/missing nonce counter/);
    } finally { db.close(); }
  });
});
