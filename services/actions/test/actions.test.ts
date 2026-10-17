/** Funding must bind the real chain, complete accounts and exact deposit instructions. */
import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { POCKET, POCKET_ACCOUNT_SIZE, TOKEN, ataAddress, pocketPda } from "@ghostlink/service-kit";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";

const genesisHash = Keypair.generate().publicKey.toBase58(), appIdHex = "01".repeat(32);
const pocket = pocketPda(Buffer.from(appIdHex, "hex")), user = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
function info(owner = TOKEN, data = Buffer.alloc(165)) { return { owner, data, executable: false, lamports: 1, rentEpoch: 0 }; }
function token(owner = user) {
  const data = Buffer.alloc(165); mint.toBuffer().copy(data); owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(1_000_000n, 64); data[108] = 1; return info(TOKEN, data);
}
function fixture() {
  let slot = 48;
  const data = Buffer.alloc(POCKET_ACCOUNT_SIZE);
  createHash("sha256").update("account:PocketV3").digest().copy(data, 0, 0, 8);
  Buffer.from(appIdHex, "hex").copy(data, 8); user.toBuffer().copy(data, 72);
  const mintData = Buffer.alloc(82); mintData[44] = 6; mintData[45] = 1;
  const state = { pocket: info(POCKET, data), mint: info(TOKEN, mintData), source: token(), destination: token(pocket) as ReturnType<typeof info> | null };
  const connection = {
    getGenesisHash: vi.fn(async () => genesisHash),
    getSlot: vi.fn(async () => ++slot),
    getMultipleAccountsInfoAndContext: vi.fn(async (keys: unknown[]) => ({ context: { slot }, value: keys.length === 1
      ? [state.pocket] : [state.pocket, state.mint, state.source, state.destination] })),
    getLatestBlockhashAndContext: vi.fn(async () => ({ context: { slot: ++slot }, value: { blockhash: genesisHash, lastValidBlockHeight: 1000 } })),
  };
  return { state, connection };
}
async function withServer(fn: (base: string, server: ReturnType<typeof buildServer>) => Promise<void>, f = fixture()) {
  const server = buildServer({ connection: f.connection as unknown as Connection, baseUrl: "https://actions.test", genesisHash });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  await server.operations.refresh(); await server.operations.refresh();
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  try { await fn(`http://127.0.0.1:${address.port}`, server); }
  finally {
    server.operations.drain(); await server.operations.refresh(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); server.operations.stop();
  }
}
function post(base: string, query = "amount=1", body: unknown = { account: user.toBase58() }) {
  return fetch(`${base}/actions/fund/${appIdHex}?${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const splQuery = `mint=${mint.toBase58()}&rawAmount=1000`;

describe("Actions deposit boundary", () => {
  it("serves metadata and preflight labeled with the approved chain, with cached readiness", async () => {
    const f = fixture();
    await withServer(async (base, server) => {
      const calls = f.connection.getSlot.mock.calls.length;
      for (const path of [`/actions/fund/${appIdHex}`, "/actions.json", "/health", "/ready"]) {
        const response = await fetch(base + path);
        expect(response.status).toBe(200); expect(response.headers.get("x-blockchain-ids")).toBe(`solana:${genesisHash.slice(0, 32)}`);
      }
      const meta = await (await fetch(`${base}/actions/fund/${appIdHex}`)).json();
      expect(meta).toMatchObject({ pocket: pocket.toBase58(), disabled: false, type: "action" });
      const options = await fetch(`${base}/actions/fund/${appIdHex}`, { method: "OPTIONS" });
      expect(options.status).toBe(204); expect(options.headers.get("access-control-allow-headers")).toContain("content-encoding");
      expect(options.headers.get("x-blockchain-ids")).toBe(`solana:${genesisHash.slice(0, 32)}`);
      expect(f.connection.getSlot).toHaveBeenCalledTimes(calls);
      expect(f.connection.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
      server.operations.drain();
      expect((await fetch(`${base}/ready`)).status).toBe(503);
      expect((await (await fetch(`${base}/actions/fund/${appIdHex}`)).json()).disabled).toBe(true);
      expect((await post(base)).status).toBe(503);
    }, f);
  });
  it("rejects missing/public deployment identity and untrusted metadata origins before RPC", () => {
    const f = fixture(), deps = { connection: f.connection as unknown as Connection, baseUrl: "https://actions.test", genesisHash };
    for (const genesis of [undefined, "not-a-chain", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"]) {
      expect(() => buildServer({ ...deps, genesisHash: genesis as string })).toThrow();
    }
    for (const baseUrl of ["http://public.test", "https://user:pass@actions.test", "https://actions.test/path", "https://actions.test?token=private"]) {
      expect(() => buildServer({ ...deps, baseUrl })).toThrow();
    }
    expect(f.connection.getGenesisHash).not.toHaveBeenCalled();
  });
  it("refuses prefunded or truncated pockets, then returns only the exact unsigned SOL transfer", async () => {
    const f = fixture(), original = f.state.pocket;
    await withServer(async base => {
      f.state.pocket = info(SystemProgram.programId, Buffer.alloc(0)); expect((await post(base)).status).toBe(400);
      f.state.pocket = info(POCKET, original.data.subarray(0, 40)); expect((await post(base)).status).toBe(400);
      f.state.pocket = original;
      const response = await post(base, "amount=1.000000001&destination=ignored"); expect(response.status).toBe(200);
      const tx = Transaction.from(Buffer.from((await response.json()).transaction, "base64"));
      expect(tx.instructions).toHaveLength(1); expect(tx.instructions[0]!.programId.equals(SystemProgram.programId)).toBe(true);
      expect(tx.instructions[0]!.keys.map(k => k.pubkey.toBase58())).toEqual([user.toBase58(), pocket.toBase58()]);
      expect(tx.instructions[0]!.data.readBigUInt64LE(4)).toBe(1_000_000_001n);
      expect(tx.feePayer?.equals(user)).toBe(true); expect(tx.signatures.every(s => s.signature === null)).toBe(true);
    }, f);
  });
  it("builds the canonical token deposit and refuses malformed mints and unsafe destination authorities", async () => {
    const f = fixture();
    await withServer(async base => {
      f.state.destination = null;
      const result = await post(base, splQuery); expect(result.status).toBe(200);
      const tx = Transaction.from(Buffer.from((await result.json()).transaction, "base64"));
      expect(tx.instructions).toHaveLength(2);
      const transfer = tx.instructions[1]!;
      expect(transfer.programId.equals(TOKEN)).toBe(true);
      expect(transfer.keys.map(k => k.pubkey.toBase58())).toEqual([ataAddress(user, mint).toBase58(), ataAddress(pocket, mint).toBase58(), user.toBase58()]);
      expect(transfer.data.readBigUInt64LE(1)).toBe(1000n);
      for (const change of [(d: Buffer) => { d.writeUInt32LE(1, 72); }, (d: Buffer) => { d.writeUInt32LE(1, 129); }, (d: Buffer) => { d[108] = 2; }]) {
        f.state.destination = token(pocket); change(f.state.destination.data);
        expect((await post(base, splQuery)).status).toBe(400);
      }
      f.state.destination = token(pocket); expect((await post(base, splQuery)).status).toBe(200);
      const original = f.state.mint;
      for (const invalid of [info(TOKEN, Buffer.alloc(165)), info(TOKEN, Buffer.alloc(82)), info(SystemProgram.programId, original.data), { ...original, executable: true }]) {
        f.state.mint = invalid; expect((await post(base, splQuery)).status).toBe(400);
      }
      f.state.mint = original; f.state.source.data.writeBigUInt64LE(999n, 64);
      expect((await post(base, splQuery)).status).toBe(400);
    }, f);
  });
  it("refuses wrong-chain, stale account and regressing blockhash evidence without leaking diagnostics", async () => {
    const f = fixture();
    await withServer(async (base, server) => {
      f.connection.getMultipleAccountsInfoAndContext.mockResolvedValueOnce({ context: { slot: 1 }, value: [f.state.pocket] });
      expect((await post(base)).status).toBe(503); expect(f.connection.getLatestBlockhashAndContext).not.toHaveBeenCalled();
      f.connection.getLatestBlockhashAndContext.mockResolvedValueOnce({ context: { slot: 1 }, value: { blockhash: genesisHash, lastValidBlockHeight: 1000 } });
      expect((await post(base)).status).toBe(503);
      f.connection.getMultipleAccountsInfoAndContext.mockRejectedValueOnce(new Error("PRIVATE_RPC_TOKEN"));
      const error = await post(base); expect(error.status).toBe(503); expect(await error.text()).not.toContain("PRIVATE_RPC_TOKEN");
      f.connection.getGenesisHash.mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());
      expect((await post(base)).status).toBe(503); expect(server.operations.snapshot().ready).toBe(false);
    }, f);
  });
  it("never lowers a context learned from a newer concurrent request", async () => {
    const f = fixture();
    await withServer(async base => {
      let release!: (value: { context: { slot: number }; value: ReturnType<typeof info>[] }) => void;
      f.connection.getMultipleAccountsInfoAndContext.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const older = post(base);
      for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(release).toBeTypeOf("function");
      expect((await post(base)).status).toBe(200);
      release({ context: { slot: 50 }, value: [f.state.pocket] });
      expect((await older).status).toBe(503);
    }, f);
  });
  it("refuses malformed or ambiguous deposit inputs before account reads", async () => {
    const f = fixture();
    await withServer(async base => {
      expect((await fetch(`${base}/actions/fund/nothex`)).status).toBe(400);
      for (const query of ["amount=1&amount=2", "amount=1&rawAmount=1", splQuery + "&amount=1", "mint=&rawAmount=1", "amount=0", "amount=1.0000000001"]) {
        expect((await post(base, query)).status).toBe(400);
      }
      expect((await post(base, "amount=1", null)).status).toBe(400);
      const malformed = await fetch(`${base}/actions/fund/${appIdHex}`, { method: "POST", body: "{" });
      expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ message: "invalid JSON body" });
      expect(malformed.headers.get("x-blockchain-ids")).toBe(`solana:${genesisHash.slice(0, 32)}`);
      const missing = await fetch(`${base}/missing`); expect(await missing.json()).toEqual({ message: "not found" });
      expect(f.connection.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
    }, f);
  });
});
