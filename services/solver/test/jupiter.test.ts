import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { ataAddress, createAtaIdempotentIx, TOKEN } from "@ghostlink/service-kit";
import { JupiterPlanner, JUPITER, fetchJupiterBuild } from "../src/jupiter.js";
import { RAYDIUM_CP, RAYDIUM_AUTHORITY, type RouteChain } from "../src/raydium.js";
import type { ValidatedIntent } from "../src/validate.js";

afterEach(() => vi.useRealTimers());
const key = () => Keypair.generate().publicKey;
function account(owner: PublicKey, size: number, name?: string): AccountInfo<Buffer> {
  const data = Buffer.alloc(size);
  if (name) createHash("sha256").update(`account:${name}`).digest().copy(data, 0, 0, 8);
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}
function wire(ix: TransactionInstruction) {
  return { programId: ix.programId.toBase58(), data: ix.data.toString("base64"),
    accounts: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isWritable: k.isWritable, isSigner: k.isSigner })) };
}

// Synthetic, deterministic-layout bank and provider response. These are adversarial contract tests,
// not evidence that a live Jupiter quote or Raydium swap has executed.
function world(shared = false, reverse = false, intermediate = false) {
  const solver = key(), pocket = key(), mint0 = key(), mint1 = key(), pool = key(), config = key(), vault0 = key(), vault1 = key(), observation = key();
  const input = reverse ? mint1 : mint0, output = reverse ? mint0 : mint1;
  const source = ataAddress(solver, input), destination = ataAddress(pocket, output);
  const authority = shared ? PublicKey.findProgramAddressSync([Buffer.from("authority"), Buffer.from([3])], JUPITER)[0] : solver;
  const dexSource = shared ? ataAddress(authority, input) : source;
  const dexDestination = shared && intermediate ? ataAddress(authority, output) : destination;
  const bank = new Map<string, AccountInfo<Buffer>>();
  const add = (address: PublicKey, a: AccountInfo<Buffer>) => { bank.set(address.toBase58(), a); return a.data; };
  const poolData = add(pool, account(RAYDIUM_CP, 637, "PoolState"));
  [config, key(), vault0, vault1, key(), mint0, mint1, TOKEN, TOKEN, observation].forEach((k, i) => poolData.set(k.toBytes(), 8 + 32 * i));
  poolData[331] = 6; poolData[332] = 6;
  const configData = add(config, account(RAYDIUM_CP, 236, "AmmConfig")); configData.writeBigUInt64LE(2500n, 12);
  const observationData = add(observation, account(RAYDIUM_CP, 4075, "ObservationState")); observationData.set(pool.toBytes(), 11);
  for (const mint of [mint0, mint1]) { const b = add(mint, account(TOKEN, 82)); b[44] = 6; b[45] = 1; }
  for (const [address, mint, owner] of [[vault0, mint0, RAYDIUM_AUTHORITY], [vault1, mint1, RAYDIUM_AUTHORITY],
    [source, input, solver], [destination, output, pocket], ...(shared ? [[dexSource, input, authority]] : []),
    ...(shared && intermediate ? [[dexDestination, output, authority]] : [])] as [PublicKey, PublicKey, PublicKey][]) {
    const b = add(address, account(TOKEN, 165)); b.set(mint.toBytes()); b.set(owner.toBytes(), 32); b[108] = 1;
  }
  for (const p of [JUPITER, RAYDIUM_CP]) add(p, { ...account(SystemProgram.programId, 36), executable: true });
  const intent = { pocket: pocket.toBytes(), nonce: 0n, inMint: input.toBytes(), inMax: 100n, outMint: output.toBytes(),
    outMin: 190n, deadlineSlot: 500n, policyHash: randomBytes(32) };
  const v: ValidatedIntent = { intent, hash: randomBytes(32), sessionKind: 0, sessionKey: solver.toBytes(), signature: randomBytes(64) };
  const data = Buffer.alloc(shared ? 40 : 39);
  data.set(shared ? [209, 152, 83, 147, 124, 254, 216, 233] : [187, 100, 250, 204, 49, 196, 175, 20]);
  if (shared) data[8] = 3;
  const offset = shared ? 9 : 8;
  data.writeBigUInt64LE(100n, offset); data.writeBigUInt64LE(200n, offset + 8); data.writeUInt16LE(50, offset + 16);
  data.writeUInt32LE(1, offset + 22); data[offset + 26] = 46; data.writeUInt16LE(10_000, offset + 27); data[offset + 30] = 1;
  const event = new PublicKey("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf");
  const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  const prefix = shared ? [m(authority), m(solver, false, true), m(source, true), m(dexSource, true), m(dexDestination, true), m(destination, true),
    m(input), m(output), m(TOKEN), m(TOKEN), m(event), m(JUPITER)] :
    [m(solver, false, true), m(source, true), m(destination, true), m(input), m(output), m(TOKEN), m(TOKEN), m(JUPITER), m(event), m(JUPITER)];
  const ix = new TransactionInstruction({ programId: JUPITER, data, keys: [...prefix, m(RAYDIUM_CP), m(authority, false, !shared), m(RAYDIUM_AUTHORITY),
    m(config), m(pool, true), m(dexSource, true), m(dexDestination, true), m(reverse ? vault1 : vault0, true), m(reverse ? vault0 : vault1, true),
    m(TOKEN), m(TOKEN), m(input), m(output), m(observation, true)] });
  const reply: Record<string, any> = { inputMint: input.toBase58(), outputMint: output.toBase58(), inAmount: "100", outAmount: "200", otherAmountThreshold: "199",
    swapMode: "ExactIn", slippageBps: 50, transactionVersion: 0,
    routePlan: [{ percent: 100, bps: 10_000, swapInfo: { ammKey: pool.toBase58(), label: "Raydium CP", inputMint: input.toBase58(), outputMint: output.toBase58(), inAmount: "100", outAmount: "200" } }],
    setupInstructions: [], computeBudgetInstructions: [], cleanupInstruction: null, tipInstruction: null, otherInstructions: [],
    swapInstruction: wire(ix), addressesByLookupTableAddress: {} };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } }));
  const chain = { getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: 101 }, value: keys.map(k => bank.get(k.toBase58()) ?? null) })) };
  const options = { apiKey: "test-key-never-log", pools: [{ pool: pool.toBase58(), token0: mint0.toBase58(), token1: mint1.toBase58(), maxTradeFeePpm: 3000 }], slippageBps: 50 };
  const planner = new JupiterPlanner(chain as unknown as RouteChain, options, fetcher);
  return { solver, pocket, input, output, source, destination, pool, config, vault0, vault1, observation, bank, poolData, configData, v,
    reply, ix, offset, fetcher, chain, options, planner, run: () => planner.plan(v, solver, 100) };
}

describe("reviewed Jupiter Raydium CP adapter", () => {
  it("binds buys and exits in both directions, with direct/shared accounts and exact requested destinations", async () => {
    for (const shared of [false, true]) for (const reverse of [false, true]) for (const intermediate of shared ? [false, true] : [false]) {
      const w = world(shared, reverse, intermediate), result = await w.run();
      expect(result.instructions).toHaveLength(1); expect(result.instructions[0]!.data).toEqual(w.ix.data); expect(result.minimumSlot).toBe(101);
      const [url, init] = w.fetcher.mock.calls[0] as unknown as [string, RequestInit];
      const query = new URL(url).searchParams;
      expect(query.get("destinationTokenAccount")).toBe(w.destination.toBase58()); expect(query.get("amount")).toBe("100");
      expect(query.get("wrapAndUnwrapSol")).toBe("false"); expect(query.get("transactionVersion")).toBe("0"); expect(init.redirect).toBe("error");
      expect(w.chain.getMultipleAccountsInfoAndContext.mock.calls[1]![1]).toEqual({ commitment: "confirmed", minContextSlot: 101 });
    }
  });

  it("refuses quote substitution, unsupported routes, extra instructions and hidden fees before account RPC", async () => {
    const mutations: ((w: ReturnType<typeof world>) => void)[] = [
      w => { w.reply.inputMint = key().toBase58(); }, w => { w.reply.inAmount = "101"; }, w => { w.reply.inAmount = "0100"; },
      w => { w.reply.otherAmountThreshold = "189"; }, w => { w.reply.slippageBps = 500; }, w => { w.reply.transactionVersion = 1; },
      w => { w.reply.routePlan.push(w.reply.routePlan[0]); }, w => { w.reply.routePlan[0].swapInfo.ammKey = key().toBase58(); },
      w => { w.reply.routePlan[0].swapInfo.outAmount = "201"; }, w => { w.reply.routePlan[0].percent = 99; },
      w => { w.reply.otherInstructions.push(w.reply.swapInstruction); }, w => { w.reply.tipInstruction = w.reply.swapInstruction; },
      w => { w.reply.cleanupInstruction = w.reply.swapInstruction; }, w => { w.reply.computeBudgetInstructions = [w.reply.swapInstruction]; },
      w => { w.reply.setupInstructions = [wire(createAtaIdempotentIx(w.solver, w.pocket, w.output))]; },
      w => { w.ix.data.writeBigUInt64LE(101n, w.offset); w.reply.swapInstruction = wire(w.ix); },
      w => { w.ix.data.writeUInt16LE(1, w.offset + 18); w.reply.swapInstruction = wire(w.ix); },
      w => { w.ix.data.writeUInt16LE(1, w.offset + 20); w.reply.swapInstruction = wire(w.ix); },
      w => { w.ix.data[w.offset + 26] = 47; w.reply.swapInstruction = wire(w.ix); },
      w => { w.ix.data = Buffer.concat([w.ix.data, Buffer.from([0])]); w.reply.swapInstruction = wire(w.ix); },
      w => { w.reply.swapInstruction.programId = SystemProgram.programId.toBase58(); },
    ];
    for (const mutate of mutations) { const w = world(); mutate(w); await expect(w.run()).rejects.toThrow(); expect(w.chain.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled(); }
  });

  it("refuses every substituted swap account and unexpected signer/writable privilege", async () => {
    for (const shared of [false, true]) {
      const sample = world(shared);
      for (let i = 0; i < sample.ix.keys.length; i++) {
        const w = world(shared); w.reply.swapInstruction.accounts[i].pubkey = key().toBase58(); await expect(w.run()).rejects.toThrow();
      }
      const signer = world(shared); signer.reply.swapInstruction.accounts[shared ? 12 : 10].isSigner = true; await expect(signer.run()).rejects.toThrow(/permissions/);
      const writable = world(shared); writable.reply.swapInstruction.accounts[shared ? 6 : 3].isWritable = true; await expect(writable.run()).rejects.toThrow(/permissions/);
      const extra = world(shared); extra.reply.swapInstruction.accounts.push(extra.reply.swapInstruction.accounts[0]); await expect(extra.run()).rejects.toThrow(/remaining/);
    }
  });

  it("checks chain owners, mint/freeze/delegate authorities, pool mappings and fee ceiling", async () => {
    const mutations: ((w: ReturnType<typeof world>) => void)[] = [
      w => { w.bank.get(w.pool.toBase58())!.owner = SystemProgram.programId; },
      w => { w.poolData[0] ^= 1; }, w => { w.poolData[329] = 4; }, w => { w.poolData.set(key().toBytes(), 168); },
      w => { w.configData.writeBigUInt64LE(3001n, 12); }, w => { w.poolData[390] = 1; w.configData.writeBigUInt64LE(501n, 108); },
      w => { w.bank.get(w.input.toBase58())!.data.writeUInt32LE(1, 46); },
      w => { w.bank.get(w.output.toBase58())!.owner = SystemProgram.programId; },
      w => { w.bank.get(w.vault0.toBase58())!.data.set(key().toBytes(), 32); },
      w => { w.bank.get(w.source.toBase58())!.data.writeUInt32LE(1, 72); },
      w => { w.bank.get(w.destination.toBase58())!.data.writeUInt32LE(1, 129); },
      w => { w.bank.get(w.destination.toBase58())!.data[108] = 2; },
      w => { w.bank.delete(w.destination.toBase58()); },
      w => { w.bank.get(w.observation.toBase58())!.data.set(key().toBytes(), 11); },
      w => { w.bank.get(JUPITER.toBase58())!.executable = false; },
    ];
    for (const mutate of mutations) { const w = world(); mutate(w); await expect(w.run()).rejects.toThrow(); }
    const allowed = world(); allowed.bank.delete(allowed.source.toBase58()); allowed.reply.setupInstructions = [wire(createAtaIdempotentIx(allowed.solver, allowed.solver, allowed.input))];
    expect((await allowed.run()).instructions).toHaveLength(1); // Source creation is the server's own instruction, not provider bytes.
  });

  it("does not allow stale contexts, passed deadlines, changed pool mappings or mutable caller policy", async () => {
    const stale = world(); stale.chain.getMultipleAccountsInfoAndContext.mockResolvedValue({ context: { slot: 99 }, value: [] });
    await expect(stale.run()).rejects.toThrow(/context/);
    const expired = world(); expired.v.intent.deadlineSlot = 100n; await expect(expired.run()).rejects.toThrow(/context/);
    const changed = world(); const original = changed.chain.getMultipleAccountsInfoAndContext.getMockImplementation()!;
    changed.chain.getMultipleAccountsInfoAndContext.mockImplementation(async keys => {
      if (keys.length > 1) changed.poolData.set(key().toBytes(), 72);
      return original(keys);
    });
    await expect(changed.run()).rejects.toThrow(/mapping changed/);
    const copied = world(); const work = copied.run(); copied.v.intent.inMax = 1n; copied.v.intent.inMint.fill(0); copied.options.pools[0]!.maxTradeFeePpm = 0;
    expect((await work).instructions[0]!.data.readBigUInt64LE(8)).toBe(100n);
    const unavailable = world(); unavailable.chain.getMultipleAccountsInfoAndContext.mockRejectedValue(new Error("https://rpc.example/secret"));
    await expect(unavailable.run()).rejects.toThrow(/^route RPC unavailable$/);
  });

  it("bounds lookup mappings for independent finalized validation and refuses malformed provider fields", async () => {
    const w = world(), table = key(); w.reply.addressesByLookupTableAddress = { [table.toBase58()]: [w.pool.toBase58(), w.vault0.toBase58()] };
    expect((await w.run()).lookupTables?.[0]?.address.equals(table)).toBe(true);
    for (const change of [
      (w: ReturnType<typeof world>) => { w.reply.addressesByLookupTableAddress = { [key().toBase58()]: Array(257).fill(w.pool.toBase58()) }; },
      (w: ReturnType<typeof world>) => { w.reply.swapInstruction.data += "\n"; },
      (w: ReturnType<typeof world>) => { w.reply.swapInstruction.accounts[0].isSigner = "true"; },
      (w: ReturnType<typeof world>) => { w.reply.routePlan = null; },
    ]) { const bad = world(); change(bad); await expect(bad.run()).rejects.toThrow(); }
  });
});

describe("Jupiter transport boundary", () => {
  it("rejects redirects/provider errors, invalid JSON and oversized declared or chunked bodies without echoing secrets", async () => {
    for (const response of [new Response("key-secret", { status: 401 }), new Response("", { status: 302, headers: { location: "https://elsewhere.example" } }),
      new Response("not json", { headers: { "content-type": "application/json" } }),
      new Response("{}", { headers: { "content-type": "application/json", "content-length": "262145" } }),
      new Response("x".repeat(262145), { headers: { "content-type": "application/json" } }), new Response("{}")]) {
      await expect(fetchJupiterBuild(new URLSearchParams(), "key-secret", async () => response)).rejects.toThrow(/^(Jupiter build unavailable|Jupiter response too large)$/);
    }
    await expect(fetchJupiterBuild(new URLSearchParams(), "key-secret", async () => { throw new Error("key-secret"); })).rejects.toThrow(/^Jupiter build unavailable$/);
  });

  it("aborts a stalled request and a stalled streamed body", async () => {
    vi.useFakeTimers();
    for (const afterHeaders of [false, true]) {
      let aborted = false;
      const fetcher: typeof fetch = async (_url, init) => {
        if (afterHeaders) return new Response(new ReadableStream({ start(c) { init!.signal!.addEventListener("abort", () => { aborted = true; c.error(new Error("secret")); }); } }),
          { headers: { "content-type": "application/json" } });
        return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("secret")); }));
      };
      const assertion = expect(fetchJupiterBuild(new URLSearchParams(), "key-secret", fetcher)).rejects.toThrow(/^Jupiter build unavailable$/);
      await vi.advanceTimersByTimeAsync(4_001); await assertion; expect(aborted).toBe(true);
    }
  });
});
