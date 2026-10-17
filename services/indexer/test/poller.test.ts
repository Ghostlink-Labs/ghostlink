import { describe, expect, it, vi } from "vitest";
import { Connection } from "@solana/web3.js";
import { CENSUS, REGISTRY, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import { Poller } from "../src/poller.js";
import { IndexerStore } from "../src/store.js";

const info = (signature: string) => ({ signature, slot: 1, err: null, memo: null, blockTime: 0 });

describe("poller transaction ordering and confirmation", () => {
  it.each([null, [`Program ${REGISTRY.toBase58()} invoke [1]`], ["Log truncated"], frameAsProgramLogs(REGISTRY.toBase58(), [`Program data: ${Buffer.from(eventDisc("Registered")).toString("base64")}`])])("refuses incomplete transaction logs without advancing the cursor: %j", async logs => {
    const store = new IndexerStore();
    const connection = { getSlot: vi.fn(async () => 1), getSignaturesForAddress: vi.fn(async () => [info("A")]),
      getTransaction: vi.fn(async () => ({ slot: 1, transaction: { signatures: ["A"] }, meta: { err: null, logMessages: logs } })) };
    await expect(new Poller(connection as unknown as Connection, store, [REGISTRY]).tick()).rejects.toThrow(/logs|truncated/);
    expect(store.cursors.size).toBe(0);
  });
  it("rejects a repeated full page before an unbounded provider scan", async () => {
    const store = new IndexerStore();
    const connection = { getSlot: vi.fn(async () => 1), getSignaturesForAddress: vi.fn(async () => {
      if (connection.getSignaturesForAddress.mock.calls.length > 3) throw new Error("test ended repeated provider pages");
      return [info("B"), info("A")];
    }) };
    await expect(new Poller(connection as unknown as Connection, store, [REGISTRY], 2).tick()).rejects.toThrow();
    expect(connection.getSignaturesForAddress.mock.calls.length).toBeLessThanOrEqual(2);
    expect(store.cursors.size).toBe(0);
  });

  it("merges same-slot ordering across programs instead of using scan order", async () => {
    // A (registry), B (registry+census), C (census): C must not precede B.
    const fetched: string[] = [];
    const store = new IndexerStore();
    const connection = { getSlot: vi.fn(async () => 1),
      getSignaturesForAddress: vi.fn(async (program) => program.equals(REGISTRY) ? [info("B"), info("A")] : [info("C"), info("B")]),
      getTransaction: vi.fn(async (signature) => { fetched.push(signature); return { slot: 1, transaction: { signatures: [signature] }, meta: { err: null, logMessages: [] } }; }),
    };
    await new Poller(connection as unknown as Connection, store, [REGISTRY, CENSUS]).tick();
    expect(fetched).toEqual(["A", "B", "C"]);
    expect(store.cursors.get(REGISTRY.toBase58())).toBe("B");
    expect(store.cursors.get(CENSUS.toBase58())).toBe("C");
  });

  it("does not ingest rolled-back logs or advance past unavailable metadata", async () => {
    const store = new IndexerStore();
    const apply = vi.spyOn(store, "apply");
    const connection = { getSlot: vi.fn(async () => 1),
      getSignaturesForAddress: vi.fn(async () => [info("A")]),
      getTransaction: vi.fn(async (): Promise<unknown> => ({ meta: null })),
    };
    const poller = new Poller(connection as unknown as Connection, store, [REGISTRY]);
    await expect(poller.tick()).rejects.toThrow(/metadata/);
    expect(store.cursors.size).toBe(0);
    const payload = Buffer.concat([eventDisc("Registered"), Buffer.alloc(136)]).toString("base64");
    connection.getTransaction.mockResolvedValue({ slot: 1, transaction: { signatures: ["A"] }, meta: { err: { InstructionError: [1, "Custom"] },
      logMessages: frameAsProgramLogs(REGISTRY.toBase58(), [`Program data: ${payload}`]) } });
    await expect(poller.tick()).rejects.toThrow(/status/);
    expect(apply).not.toHaveBeenCalled();
    expect(store.cursors.size).toBe(0);

    // A failed transaction reported consistently by the signature page has no committed events.
    const failedConnection = { ...connection, getSignaturesForAddress: vi.fn(async () => [
      { ...info("A"), err: { InstructionError: [1, "Custom"] } },
    ]) };
    const failedStore = new IndexerStore();
    await new Poller(failedConnection as unknown as Connection, failedStore, [REGISTRY]).tick();
    expect(failedStore.cursors.get(REGISTRY.toBase58())).toBe("A");
  });
});
