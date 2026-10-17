import { once } from "node:events";
import { Connection } from "@solana/web3.js";
import { REGISTRY } from "@ghostlink/service-kit";
import { expect, it, vi } from "vitest";
import { Poller } from "../src/poller.js";
import { buildServer } from "../src/server.js";
import { IndexerStore } from "../src/store.js";

it("keeps provider diagnostics out of public polling status and retains the cursor on failure", async () => {
  const marker = "SYNTHETIC_INDEXER_PROVIDER_SECRET";
  const connection = { getSlot: vi.fn(async () => 1), getSignaturesForAddress: vi.fn().mockRejectedValue(new Error(`RPC ${marker}`)) };
  const store = new IndexerStore();
  store.setCursor(REGISTRY.toBase58(), "existing-cursor");
  const poller = new Poller(connection as unknown as Connection, store, [REGISTRY]);
  await expect(poller.tick()).rejects.toThrow();
  const server = buildServer(store, { poller: poller.status });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  try {
    const health = await (await fetch(`http://127.0.0.1:${address.port}/health`)).json();
    expect(health.ok).toBe(false);
    expect(JSON.stringify(health)).not.toContain(marker);
    expect(JSON.stringify(poller.status)).not.toContain(marker);
    expect(store.cursors.get(REGISTRY.toBase58())).toBe("existing-cursor");
    connection.getSignaturesForAddress.mockResolvedValue([{ signature: "existing-cursor", slot: 1, err: null }]);
    await poller.tick();
    expect((await (await fetch(`http://127.0.0.1:${address.port}/health`)).json()).ok).toBe(true);
    expect(poller.status.lastError).toBeNull();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
