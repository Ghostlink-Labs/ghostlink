import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { createRpcPool } from "../src/rpc.js";

const genesisHash = Keypair.generate().publicKey.toBase58();
const signature = bs58.encode(new Uint8Array(64).fill(1));
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
type Call = { jsonrpc: string; id: string | number; method: string; params: any[] };
async function provider(work: (r: Call, res: ServerResponse) => unknown, genesis = genesisHash) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw) as Call; calls.push(request);
    if (request.method === "getGenesisHash") return reply(res, request, genesis);
    await work(request, res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  return { url: `http://127.0.0.1:${address.port}?key=PRIVATE_TEST_VALUE`, calls };
}
function reply(res: ServerResponse, request: Call, result: unknown) {
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
function pool(endpoints: { url: string }[], config: Partial<Parameters<typeof createRpcPool>[0]> = {}) {
  const p = createRpcPool({ genesisHash, endpoints, endpointTimeoutMs: 250, requestTimeoutMs: 1000, pollIntervalMs: 10, ...config });
  cleanups.push(() => p.close()); return p;
}
function signedPacket() {
  const signer = Keypair.generate();
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: genesisHash }).add(
    SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.sign(signer); return tx.serialize();
}

describe("operator HTTP RPC failover", () => {
  it("quarantines a wrong genesis before any business request and sanitizes health", async () => {
    const wrong = await provider(() => { throw new Error("must never send"); }, Keypair.generate().publicKey.toBase58());
    const good = await provider((r, res) => reply(res, r, 20));
    const p = pool([wrong, good]);
    expect(await p.connection.getSlot()).toBe(20);
    expect(await p.connection.getSlot()).toBe(20);
    expect(wrong.calls.map(c => c.method)).toEqual(["getGenesisHash"]);
    expect(p.status().endpoints[0]?.state).toBe("quarantined");
    expect(JSON.stringify(p.status())).not.toContain("PRIVATE_TEST_VALUE");
    expect(p.connection.rpcEndpoint).toBe("https://ghostlink-rpc.invalid");
  });

  it.each(["timeout", "http", "unhealthy", "malformed", "oversized"])("recovers from %s without leaking provider diagnostics", async mode => {
    const bad = await provider((r, res) => {
      if (mode === "timeout") return;
      if (mode === "http") { res.writeHead(429); res.end("PRIVATE_TEST_VALUE"); return; }
      if (mode === "oversized") { res.end("x".repeat(2048)); return; }
      res.end(mode === "unhealthy" ? JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32005, message: "PRIVATE_TEST_VALUE" } }) : "PRIVATE_TEST_VALUE");
    });
    const good = await provider((r, res) => reply(res, r, 12));
    const p = pool([bad, good], { maxResponseBytes: 1024 });
    expect(await p.connection.getSlot()).toBe(12);
    expect(p.status().preferred).toBe(1);
    expect(JSON.stringify(p.status())).not.toContain("PRIVATE_TEST_VALUE");
    expect(bad.calls.filter(c => c.method === "getSlot")).toHaveLength(1);
  });

  it("retries identical signed bytes after an accepted send loses its acknowledgment", async () => {
    const bad = await provider((_r, res) => res.destroy());
    const good = await provider((r, res) => reply(res, r, signature));
    const p = pool([bad, good]);
    const raw = signedPacket();
    expect(await p.connection.sendRawTransaction(raw, { maxRetries: 0, minContextSlot: 9, preflightCommitment: "confirmed" })).toBe(signature);
    const sent = [bad, good].map(v => v.calls.find(r => r.method === "sendTransaction")!);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[0].params[0]).toBe(raw.toString("base64"));
    expect(sent[0].params[1].minContextSlot).toBe(9);
  });

  it("returns semantic RPC rejection once, without untrusted text or replay amplification", async () => {
    const bad = await provider((r, res) => res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id,
      error: { code: -32602, message: "PRIVATE_TEST_VALUE", data: { logs: ["PRIVATE_TEST_VALUE"] } } })));
    const good = await provider((r, res) => reply(res, r, 12));
    const p = pool([bad, good]);
    await expect(p.connection.getSlot()).rejects.toThrow("RPC request rejected");
    expect(good.calls).toHaveLength(0);
  });

  it("refuses stale authority context, separates processed status from confirmed/finalized floors", async () => {
    let stale = false;
    const first = await provider((r, res) => reply(res, r, r.method === "getSlot" ? (stale ? 19 : 20) :
      r.method === "getSignatureStatuses" ? { context: { slot: 50 }, value: [null] } : { context: { slot: 19 }, value: null }));
    const second = await provider((r, res) => reply(res, r, r.method === "getSlot" ?
      (r.params[0].commitment === "finalized" ? 18 : 22) : { context: { slot: 22 }, value: null }));
    const p = pool([first, second]);
    expect(await p.connection.getSlot("confirmed")).toBe(20);
    await p.connection.getSignatureStatuses([signature]);
    stale = true;
    const result = await p.connection.getAccountInfoAndContext(Keypair.generate().publicKey, { commitment: "confirmed", minContextSlot: 21 });
    expect(result.context.slot).toBe(22);
    expect(await p.connection.getSlot("finalized")).toBe(18);
    expect(p.status().floors).toEqual({ processed: 50, confirmed: 22, finalized: 18 });
    expect(p.status().endpoints[0]?.reason).toBe("stale");
  });

  it("confirms via HTTP fallback with signature history and no WebSocket", async () => {
    const bad = await provider((_r, res) => { res.writeHead(503); res.end(); });
    const good = await provider((r, res) => reply(res, r, { context: { slot: 20 }, value: [
      { slot: 19, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }));
    const p = pool([bad, good]);
    const result = await p.connection.confirmTransaction({ signature, blockhash: genesisHash, lastValidBlockHeight: 100 }, "confirmed");
    expect(result.value.err).toBeNull();
    expect(good.calls.find(c => c.method === "getSignatureStatuses")?.params[1]).toEqual({ searchTransactionHistory: true });
    expect(() => p.connection.onSlotChange(() => {})).toThrow("unsupported");
  });

  it("cancels a hanging confirmation and closes outstanding requests", async () => {
    const bad = await provider(() => {});
    const p = pool([bad], { endpointTimeoutMs: 1000, requestTimeoutMs: 1200 });
    const abort = new AbortController();
    const pending = p.connection.confirmTransaction({ signature, blockhash: genesisHash, lastValidBlockHeight: 100, abortSignal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    await expect(pending).rejects.toThrow("aborted");
    expect(p.status().active).toBe(0);
    expect(p.status().endpoints[0]?.failures).toBe(0);
    const outstanding = p.connection.getSlot(); p.close();
    await expect(outstanding).rejects.toThrow("closed");
    await expect(p.connection.getSlot()).rejects.toThrow("closed");
  });

  it("keeps uncertainty bounded when all providers are unavailable", async () => {
    const first = await provider((_r, res) => res.destroy());
    const second = await provider((_r, res) => { res.writeHead(502); res.end(); });
    const p = pool([first, second], { confirmationTimeoutMs: 100 });
    await expect(p.connection.sendRawTransaction(signedPacket())).rejects.toThrow("RPC pool unavailable");
    await expect(p.connection.confirmTransaction({ signature, blockhash: genesisHash, lastValidBlockHeight: 100 })).rejects.toThrow("aborted");
    expect(p.status().active).toBe(0);
    expect([first, second].map(p => p.calls.filter(r => r.method === "sendTransaction").length)).toEqual([1, 1]);
  });

  it("waits for the requested commitment and returns a confirmed chain failure as a failure", async () => {
    let checks = 0;
    const good = await provider((r, res) => reply(res, r, { context: { slot: 20 }, value: [
      { slot: 19, confirmations: ++checks === 1 ? 0 : 1, err: { InstructionError: [0, { Custom: 1 }] },
        confirmationStatus: checks === 1 ? "processed" : "confirmed" }] }));
    const p = pool([good]);
    const result = await p.connection.confirmTransaction(signature, "confirmed");
    expect(checks).toBe(2);
    expect(result.value.err).toEqual({ InstructionError: [0, { Custom: 1 }] });
  });

  it("never calls the network for unsupported writes or unsafe endpoint configurations", async () => {
    const good = await provider((r, res) => reply(res, r, 1));
    const p = pool([good]);
    await expect(p.connection.requestAirdrop(Keypair.generate().publicKey, 1)).rejects.toThrow("unsupported");
    await expect(p.connection.confirmTransaction({ signature, minContextSlot: 1, nonceAccountPubkey: Keypair.generate().publicKey, nonceValue: genesisHash })).rejects.toThrow("unsupported");
    expect(good.calls).toHaveLength(0);
    for (const url of ["http://example.com", "https://user:secret@example.com", "https://example.com/#secret"]) {
      expect(() => pool([{ url }])).toThrow("HTTPS");
    }
  });
});
