import { afterEach, describe, expect, it } from "vitest";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { conservativePolicy, intentHash } from "@ghostlink/common";
import { BotKeyStore, BotOnboarding, createBotAuthorizationServer, type BotConsent } from "../src/index.js";
import { deployment, initData, NOW, pocketAccount, TOKEN, USER } from "./helpers.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.reverse()) await f(); cleanup.length = 0; });

function world() {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-bot-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "bot.sqlite");
  const key = randomBytes(32);
  const stores: BotKeyStore[] = [];
  cleanup.push(() => { for (const s of stores) s.close(); });
  const store = () => { const s = new BotKeyStore(path, key); stores.push(s); return s; };
  let now = NOW;
  let head = 100;
  let context = 100;
  let genesis = deployment.genesisHash;
  let info: ReturnType<typeof pocketAccount> | null = null;
  let wait: (() => Promise<void>) | undefined;
  const chain = {
    getGenesisHash: async () => genesis,
    getSlot: async () => head,
    getAccountInfoAndContext: async (_address: PublicKey, config: { minContextSlot?: number }) => {
      expect(config.minContextSlot).toBe(head);
      await wait?.();
      return { context: { slot: context }, value: info };
    },
  };
  const options = { botToken: TOKEN, chain, appOrigin: "https://bot.example.com", deployment, policy: conservativePolicy(), nowSeconds: () => now };
  const manager = (s = store()) => new BotOnboarding({ ...options, store: s });
  const input = { requestKey: "ab".repeat(16), appId: "23", home: new PublicKey(randomBytes(32)).toBase58(), sessionExpirySlot: "1000" };
  const intent = { nonce: 7n, inMint: new Uint8Array(32).fill(2), inMax: 10n, outMint: new Uint8Array(32).fill(3), outMin: 9n, deadlineSlot: 500n };
  return { path, key, store, manager, options, input, intent, chain, stores,
    activate: (c: BotConsent) => { info = pocketAccount(c); },
    setInfo: (value: typeof info) => { info = value; },
    setNow: (value: number) => { now = value; }, setHead: (value: number) => { head = value; },
    setContext: (value: number) => { context = value; }, setGenesis: (value: string) => { genesis = value; },
    setWait: (value: typeof wait) => { wait = value; },
  };
}

describe("durable bot authorization", () => {
  it("keeps one encrypted key across duplicate requests and process-style restart, then signs only after chain confirmation", async () => {
    const w = world(); const manager = w.manager();
    const a = await manager.create(initData(), w.input);
    expect(a.state).toBe("pending");
    await expect(manager.signIntent(a.consent.id, USER, w.intent)).rejects.toThrow(/not active/);
    await expect(manager.confirm(initData(), a.consent.id)).rejects.toThrow(/unavailable/);
    const secondStore = w.store(); const restarted = w.manager(secondStore);
    const duplicate = await restarted.create(initData(), w.input);
    expect(duplicate).toEqual(a);
    await expect(restarted.create(initData(), { ...w.input, sessionExpirySlot: "1001" })).rejects.toThrow(/different permissions/);
    w.activate(a.consent);
    const [one, two] = await Promise.all([manager.confirm(initData(), a.consent.id), restarted.confirm(initData(), a.consent.id)]);
    expect(one).toEqual(two); expect(one.state).toBe("confirmed");
    const signed = await restarted.signIntent(a.consent.id, USER, w.intent);
    const key = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(a.consent.sessionKeyHex, "hex"),
    ]) });
    expect(verify(null, intentHash(signed.intent), key, signed.signature.signature)).toBe(true);
    expect(JSON.stringify(manager)).toBe("{}");
    expect(JSON.stringify(secondStore)).toBe("{}");
    expect(JSON.stringify(a)).not.toMatch(/private|seed|encrypted_key|botToken|witness/);
    expect(readFileSync(w.path).includes(w.key)).toBe(false);
    expect(() => new BotKeyStore(w.path, randomBytes(32))).toThrow();
    restarted.cancel(initData(), a.consent.id);
    await expect(manager.confirm(initData(), a.consent.id)).rejects.toThrow(/no longer pending/);
    await expect(manager.signIntent(a.consent.id, USER, w.intent)).rejects.toThrow(/not active/);
  });

  it("refuses another user, expired requests and caller-substituted chain identity or permissions", async () => {
    const w = world(); const m = w.manager();
    const { consent: c } = await m.create(initData(), w.input);
    expect(() => m.status(initData(43), c.id)).toThrow(/not found/);
    await expect(m.confirm(initData(43), c.id)).rejects.toThrow(/not found/);
    for (const altered of [
      { ...c, home: new PublicKey(randomBytes(32)).toBase58() },
      { ...c, appOrigin: "https://other.example.com" },
      { ...c, sessionKeyHex: "11".repeat(32) },
      { ...c, sessionExpirySlot: "999" },
      { ...c, policy: { ...c.policy, dailyCapUsdE6: "1" } },
    ]) {
      w.activate(altered);
      await expect(m.confirm(initData(), c.id)).rejects.toThrow(/permissions/);
    }
    const foreign = pocketAccount(c); foreign.owner = new PublicKey(randomBytes(32)); w.setInfo(foreign);
    await expect(m.confirm(initData(), c.id)).rejects.toThrow(/Pocket/);
    w.activate(c); w.setContext(99);
    await expect(m.confirm(initData(), c.id)).rejects.toThrow(/stale/);
    w.setContext(100); w.setGenesis(new PublicKey(randomBytes(32)).toBase58());
    await expect(m.confirm(initData(), c.id)).rejects.toThrow(/genesis/);
    w.setGenesis(deployment.genesisHash); w.setNow(NOW + 301);
    expect(m.status(initData(42, NOW + 301), c.id).state).toBe("expired");
    await expect(m.confirm(initData(42, NOW + 301), c.id)).rejects.toThrow(/no longer pending/);
  });

  it("rechecks cancellation during RPC and revocation/replacement before each signature", async () => {
    const w = world(); const m = w.manager();
    const { consent: c } = await m.create(initData(), w.input); w.activate(c);
    let release!: () => void;
    w.setWait(() => new Promise<void>(resolve => { release = resolve; }));
    const confirming = m.confirm(initData(), c.id);
    // Advance promises until the actual RPC read is paused.
    while (!release) await new Promise(resolve => setImmediate(resolve));
    m.cancel(initData(), c.id); release();
    await expect(confirming).rejects.toThrow(/no longer pending/);
    w.setWait(undefined);
    const { consent: next } = await m.create(initData(), { ...w.input, requestKey: "cd".repeat(16) }); w.activate(next);
    await m.confirm(initData(), next.id);
    w.activate({ ...next, sessionExpirySlot: "0" });
    await expect(m.signIntent(next.id, USER, w.intent)).rejects.toThrow(/permissions/);
    w.activate({ ...next, sessionKeyHex: "22".repeat(32) });
    await expect(m.signIntent(next.id, USER, w.intent)).rejects.toThrow(/permissions/);
    w.activate(next); w.setContext(1000); w.setHead(1000);
    await expect(m.signIntent(next.id, USER, w.intent)).rejects.toThrow(/permissions/);
  });

  it("protects the HTTP boundary and accepts no claimed transaction, policy or private identity", async () => {
    const w = world(); const m = w.manager();
    const server = createBotAuthorizationServer(m, "https://owner.example.com");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown, origin = "https://owner.example.com", user = 42) => fetch(endpoint + path, {
      method: "POST", headers: { origin, authorization: "tma " + initData(user), "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await post("/requests", w.input, "https://evil.example.com")).status).toBe(403);
    expect((await post("/requests", { ...w.input, policy: {} })).status).toBe(403);
    const response = await post("/requests", w.input);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const { consent } = await response.json() as { consent: BotConsent };
    expect((await post(`/requests/${consent.id}/confirm`, { signature: "pretend-confirmed" })).status).toBe(403);
    expect((await post(`/requests/${consent.id}/confirm`, {}, "https://owner.example.com", 43)).status).toBe(403);
    w.activate(consent);
    expect((await post(`/requests/${consent.id}/confirm`, {})).status).toBe(200);
    expect((await post(`/requests/${consent.id}/sign`, {})).status).toBe(404);
  });

  it("refuses excess concurrent HTTP work while RPC is paused, then recovers without a queued request", async () => {
    const w = world(); const m = w.manager();
    const { consent } = await m.create(initData(), w.input); w.activate(consent);
    const releases: (() => void)[] = [];
    w.setWait(() => new Promise<void>(resolve => releases.push(resolve)));
    const server = createBotAuthorizationServer(m, "https://owner.example.com");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
    const post = () => fetch(`http://127.0.0.1:${address.port}/requests/${consent.id}/confirm`, {
      method: "POST", headers: { origin: "https://owner.example.com", authorization: "tma " + initData(), "content-type": "application/json" }, body: "{}",
    });
    const requests = Array.from({ length: 8 }, post);
    try {
      const deadline = Date.now() + 2000;
      while (releases.length < 8 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
      expect(releases).toHaveLength(8);
      expect((await post()).status).toBe(503);
    } finally { w.setWait(undefined); for (const release of releases) release(); }
    expect((await Promise.all(requests)).map(r => r.status)).toEqual(Array(8).fill(200));
    expect((await post()).status).toBe(200);
  });
});
