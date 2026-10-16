import { describe, expect, it, vi } from "vitest";
import { Connection } from "@solana/web3.js";
import { CENSUS, REGISTRY, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import { Poller } from "../src/poller.js";
import { IndexerStore } from "../src/store.js";

const info = (signature: string) => ({ signature, slot: 1, err: null, memo: null, blockTime: 0 });

describe("poller transaction ordering and confirmation", () => {
  it("merges same-slot ordering across programs instead of using scan order", async () => {
    // A (registry), B (registry+census), C (census): C must not precede B.
    const fetched: string[] = [];
    const store = new IndexerStore();
    const connection = {
      getSignaturesForAddress: vi.fn(async (program) => program.equals(REGISTRY) ? [info("B"), info("A")] : [info("C"), info("B")]),
      getTransaction: vi.fn(async (signature) => { fetched.push(signature); return { meta: { err: null, logMessages: [] } }; }),
    };
    await new Poller(connection as unknown as Connection, store, [REGISTRY, CENSUS]).tick();
    expect(fetched).toEqual(["A", "B", "C"]);
    expect(store.cursors.get(REGISTRY.toBase58())).toBe("B");
    expect(store.cursors.get(CENSUS.toBase58())).toBe("C");
  });

  it("does not ingest rolled-back logs or advance past unavailable metadata", async () => {
    const store = new IndexerStore();
    const apply = vi.spyOn(store, "apply");
    const connection = {
      getSignaturesForAddress: vi.fn(async () => [info("A")]),
      getTransaction: vi.fn(async (): Promise<unknown> => ({ meta: null })),
    };
    const poller = new Poller(connection as unknown as Connection, store, [REGISTRY]);
    await expect(poller.tick()).rejects.toThrow(/metadata/);
    expect(store.cursors.size).toBe(0);
    const payload = Buffer.concat([eventDisc("Registered"), Buffer.alloc(136)]).toString("base64");
    connection.getTransaction.mockResolvedValue({ meta: { err: { InstructionError: [1, "Custom"] },
      logMessages: frameAsProgramLogs(REGISTRY.toBase58(), [`Program data: ${payload}`]) } });
    await poller.tick();
    expect(apply).not.toHaveBeenCalled();
    expect(store.cursors.get(REGISTRY.toBase58())).toBe("A");
  });
});
