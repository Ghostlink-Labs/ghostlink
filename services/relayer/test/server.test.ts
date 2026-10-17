import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { POCKET_ACCOUNT_SIZE } from "@ghostlink/service-kit";
import { buildServer, type RelayerDeps } from "../src/server.js";

const payer = Keypair.generate();
function rpc() {
  return {
    getAccountInfo: vi.fn(async () => ({ owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 100 })),
    getFeeForMessage: vi.fn(async () => ({ value: 10_000 })),
    getMinimumBalanceForRentExemption: vi.fn(async () => 30_000_000),
    sendRawTransaction: vi.fn(async (bytes: Uint8Array) => bs58.encode(Transaction.from(bytes).signature!)),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
  };
}
async function withServer(deps: Partial<RelayerDeps>, run: (base: string) => Promise<void>) {
  const server = buildServer({ connection: rpc() as unknown as Connection, payer, ...deps });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); server.close(); }
}
function post(base: string, path: string, body: unknown) {
  return fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const snapshot = () => ({ wallet: Keypair.generate().publicKey.toBase58(), holding: payer.publicKey.toBase58() });
const opening = () => ({
  appIdHex: "01".repeat(32), domainHashHex: "02".repeat(32), sessionKind: 0,
  proofAHex: "00".repeat(64), proofBHex: "00".repeat(128), proofCHex: "00".repeat(64),
  registryRootHex: "00".repeat(32), censusRootHex: "00".repeat(32),
  mint: payer.publicKey.toBase58(), threshold: "0", minSlot: "0", claimHoldings: false,
  sessionKeyHex: "03".repeat(33), sessionExpirySlot: "100", home: payer.publicKey.toBase58(),
  policy: { dailyCapUsdE6: "100", bigActionThresholdUsdE6: "10", noOracleCapUsdE6: "0", sessionMaxSlots: "100",
    maxSlippageBps: 0, allowedOutMints: [], oracleFeeds: [] },
});

describe("relayer fee and creation boundary", () => {
  it("reserves current-layout quoted rent before funding pocket creation", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection, dailyBudgetLamports: 20_000_000n }, async base => {
      expect((await post(base, "open-session", opening())).status).toBe(503);
      expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(POCKET_ACCOUNT_SIZE, "confirmed");
      expect(connection.sendRawTransaction).not.toHaveBeenCalled();
      expect((await (await fetch(`${base}/health`)).json()).spentLamports24h).toBe("0");
      connection.getMinimumBalanceForRentExemption.mockResolvedValueOnce(19_990_000);
      expect((await post(base, "open-session", opening())).status).toBe(200);
      expect((await (await fetch(`${base}/health`)).json()).spentLamports24h).toBe("20000000");
    });
  });

  it("never echoes provider broadcast/confirmation diagnostics and keeps uncertain sends charged", async () => {
    const marker = "SYNTHETIC_RELAYER_PROVIDER_SECRET";
    const connection = rpc();
    connection.sendRawTransaction.mockRejectedValueOnce(new Error(`provider ${marker}`));
    connection.confirmTransaction.mockRejectedValueOnce(new Error(`confirmation ${marker}`))
      .mockResolvedValueOnce({ value: { err: { InstructionError: [0, marker] } } } as never);
    await withServer({ connection: connection as unknown as Connection }, async base => {
      for (let i = 0; i < 3; i++) {
        const response = await post(base, "snapshot", snapshot());
        expect(response.status).toBe(502);
        const body = await response.text();
        expect(body).not.toContain(marker);
        const signature = bs58.encode(Transaction.from(connection.sendRawTransaction.mock.calls[i]![0]).signature!);
        expect(body).toContain(signature);
      }
      expect((await (await fetch(`${base}/health`)).json()).spentLamports24h).toBe("30000");
    });
  });

  it("does not confirm a provider-substituted transaction signature", async () => {
    const connection = rpc();
    const substituted = bs58.encode(new Uint8Array(64).fill(7));
    connection.sendRawTransaction.mockResolvedValueOnce(substituted);
    await withServer({ connection: connection as unknown as Connection }, async base => {
      const response = await post(base, "snapshot", snapshot());
      expect(response.status).toBe(502);
      const body = await response.text();
      const expected = bs58.encode(Transaction.from(connection.sendRawTransaction.mock.calls[0]![0]).signature!);
      expect(body).toContain(expected);
      expect(body).not.toContain(substituted);
      expect(connection.confirmTransaction).not.toHaveBeenCalled();
      expect((await (await fetch(`${base}/health`)).json()).spentLamports24h).toBe("10000");
    });
  });

  it("does not let a prefunded system PDA bypass the partner allowlist", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection, allowedDomainHashes: new Set() }, async (base) => {
      const response = await post(base, "open-session", { appIdHex: "01".repeat(32), domainHashHex: "02".repeat(32), sessionKind: 0 });
      expect(response.status).toBe(403);
      expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    });
  });

  it("charges the actual quoted fee atomically so concurrent requests cannot exceed the budget", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection, dailyBudgetLamports: 10_000n }, async (base) => {
      const responses = await Promise.all([post(base, "snapshot", snapshot()), post(base, "snapshot", snapshot())]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 503]);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
      expect((await (await fetch(`${base}/health`)).json()).spentLamports24h).toBe("10000");
    });
  });

  it("keeps an ambiguous broadcast charged, but does not charge a preparation failure", async () => {
    const connection = rpc();
    connection.getLatestBlockhash.mockRejectedValueOnce(new Error("RPC unavailable"));
    connection.sendRawTransaction.mockRejectedValueOnce(new Error("response lost after broadcast"));
    await withServer({ connection: connection as unknown as Connection, dailyBudgetLamports: 10_000n }, async (base) => {
      expect((await post(base, "snapshot", snapshot())).status).toBe(500);
      expect((await (await fetch(`${base}/health`)).json()).spentLamports24h).toBe("0");
      expect((await post(base, "snapshot", snapshot())).status).toBe(502);
      expect((await post(base, "snapshot", snapshot())).status).toBe(503);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects malformed bodies with a client error before any paid operation", async () => {
    await withServer({}, async (base) => {
      for (const path of ["snapshot", "register", "open-session", "owner-action"]) {
        expect((await post(base, path, null)).status).toBe(400);
      }
    });
  });
});
