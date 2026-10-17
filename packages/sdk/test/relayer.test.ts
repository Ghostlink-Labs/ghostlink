import { describe, expect, it, vi } from "vitest";
import { RelayerClient, RelayerOperationPendingError, prepareRelayerOperation } from "../src/relayer.js";
import { relayerRequestDigest } from "@ghostlink/common";

const id = "01".repeat(32);
const operation = () => prepareRelayerOperation("/snapshot", { wallet: "wallet", holding: "holding" }, id);
describe("recoverable relayer operations", () => {
  it("snapshots the exact submitted operation before a network failure or caller mutation", async () => {
    const original = operation(); let reject!: (error: Error) => void;
    const transport = vi.fn(() => new Promise<Response>((_resolve, fail) => { reject = fail; }));
    const pending = new RelayerClient("https://relayer.test", transport).submit(original);
    original.request.holding = "different"; original.requestIdHex = "02".repeat(32);
    reject(new Error("SYNTHETIC_PROVIDER_SECRET"));
    const error = await pending.catch(error => error);
    expect(error).toBeInstanceOf(RelayerOperationPendingError);
    expect(error.operation).toEqual(operation()); expect(error.message).not.toContain("SYNTHETIC_PROVIDER_SECRET");
    expect(JSON.parse(transport.mock.calls[0]![1].body as string).requestIdHex).toBe(id);
  });
  it("refuses mutation before sending and preserves recovery data after invalid or substituted receipts", async () => {
    const send = vi.fn(async () => Response.json({ requestIdHex: "02".repeat(32), state: "confirmed", signature: "1".repeat(64), slot: 50, confirmationStatus: "confirmed" }));
    const client = new RelayerClient("https://relayer.test", send), changed = operation();
    changed.request.wallet = "different";
    await expect(client.submit(changed)).rejects.toThrow("mutated"); expect(send).not.toHaveBeenCalled();
    await expect(client.submit(operation())).rejects.toMatchObject({ operation: operation() });
    send.mockImplementation(async () => Response.json({ requestIdHex: id, state: "confirmed", signature: "1".repeat(64) } as any));
    await expect(client.submit(operation())).rejects.toBeInstanceOf(RelayerOperationPendingError);
  });
  it("returns pending and failed receipts without misreporting confirmation", async () => {
    const send = vi.fn(async () => Response.json({ requestIdHex: id, state: "pending", signature: "1".repeat(64) }, { status: 202 }));
    const client = new RelayerClient("https://relayer.test", send);
    expect((await client.submit(operation())).state).toBe("pending");
    send.mockImplementation(async () => Response.json({ requestIdHex: id, state: "failed", signature: "1".repeat(64), slot: 50, confirmationStatus: "finalized" }, { status: 502 }));
    expect((await client.submit(operation())).state).toBe("failed");
  });
  it("keeps exact JSON identity across serialization and distinguishes routes and changed bodies", () => {
    const original = operation();
    expect(relayerRequestDigest("/snapshot", { holding: "holding", wallet: "wallet", requestIdHex: id })).toBe(original.digestHex);
    expect(relayerRequestDigest("/register", original.request)).not.toBe(original.digestHex);
    expect(relayerRequestDigest("/snapshot", { ...original.request, holding: "different" })).not.toBe(original.digestHex);
    expect(() => relayerRequestDigest("/snapshot", { amount: 1n })).toThrow("JSON");
  });
});
