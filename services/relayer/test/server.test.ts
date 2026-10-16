import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, SystemProgram } from "@solana/web3.js";
import { buildServer, type RelayerDeps } from "../src/server.js";

const payer = Keypair.generate();
function rpc() {
  return {
    getAccountInfo: vi.fn(async () => ({ owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 100 })),
    getFeeForMessage: vi.fn(async () => ({ value: 10_000 })),
    sendRawTransaction: vi.fn(async () => "signature"),
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

describe("relayer fee and creation boundary", () => {
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
