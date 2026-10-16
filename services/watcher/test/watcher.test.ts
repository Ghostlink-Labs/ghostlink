/** Event-to-notification mapping and the timelock crank's bookkeeping. */
import { describe, expect, it } from "vitest";
import { PendingChanges, eventsToNotifications } from "../src/index.js";

describe("pending changes", () => {
  it("remembers proposals until executed or cancelled, and reports the due ones", () => {
    const pending = new PendingChanges();
    pending.observe([
      { kind: "ChangeProposed", pocket: "A", executableAfterSlot: 100n },
      { kind: "ChangeProposed", pocket: "B", executableAfterSlot: 200n },
      { kind: "ChangeProposed", pocket: "C", executableAfterSlot: 50n },
      { kind: "ChangeCanceled", pocket: "C" },
    ]);
    expect(pending.size).toBe(2);
    expect(pending.due(99n)).toEqual([]);
    expect(pending.due(150n)).toEqual(["A"]);
    expect(pending.due(1000n)).toEqual(["A", "B"]);
    pending.observe([{ kind: "ChangeExecuted", pocket: "A" }]);
    expect(pending.due(1000n)).toEqual(["B"]);
    pending.forget("B");
    expect(pending.size).toBe(0);
  });
});

describe("watcher notifications", () => {
  it("alerts on change proposals and large fills only", () => {
    const notifications = eventsToNotifications(
      [
        {
          kind: "ChangeProposed",
          pocket: "Pkt111",
          executableAfterSlot: 123n,
        },
        {
          kind: "Filled",
          pocket: "Pkt111",
          intentHash: new Uint8Array(32),
          inMint: "USDC",
          inMax: 1n,
          outMint: "SOL",
          outReceived: 1n,
          inValueUsdE6: 250_000_000n, // $250
        },
        {
          kind: "Filled",
          pocket: "Pkt111",
          intentHash: new Uint8Array(32),
          inMint: "USDC",
          inMax: 1n,
          outMint: "SOL",
          outReceived: 1n,
          inValueUsdE6: 5_000_000n, // $5 — below threshold
        },
      ],
      100_000_000n,
    );
    expect(notifications).toHaveLength(2);
    expect(notifications[0]!.subject).toContain("timelock");
    expect(notifications[1]!.subject).toContain("Large fill");
  });
});
