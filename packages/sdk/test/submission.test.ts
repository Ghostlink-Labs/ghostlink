import { describe, expect, it, vi } from "vitest";
import { bytesToHex, intentHash, toBase58 } from "@ghostlink/common";
import { ed25519 } from "@noble/curves/ed25519";
import { GhostLink, derivePocket, signIntent, softwareSession, type IntentSubmission } from "../src/index.js";

describe("intent submission lifecycle", () => {
  it("retains pending/unknown states and retries the exact signed payload without signing again", async () => {
    const session = softwareSession(); const sign = vi.spyOn(session, "sign");
    const pocket = derivePocket(23n, new Uint8Array(32).fill(1));
    const params = { nonce: 7n, inMint: new Uint8Array(32).fill(2), inMax: 10n, outMint: new Uint8Array(32).fill(3), outMin: 9n, deadlineSlot: 500n };
    const signature = toBase58(new Uint8Array(64).fill(7));
    let response: IntentSubmission;
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!response) {
        const body = JSON.parse(init!.body as string);
        const hash = bytesToHex(intentHash({ ...params, pocket: pocket.address, policyHash: (await import("@ghostlink/common")).hexToBytes(body.policyHashHex) }));
        response = { intentHashHex: hash, state: "pending", signature };
      }
      return new Response(JSON.stringify(response), { status: response.state === "pending" ? 202 : 200 });
    });
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.example.com", solver: "https://solver.example.com", fetchFn });
    const submitted = await client.submitIntent(pocket, session, params);
    expect(submitted.tx.state).toBe("pending");
    response = { intentHashHex: submitted.tx.intentHashHex, state: "unknown", signature, reason: "rpc_unavailable" };
    expect((await client.intentStatus(submitted.tx.intentHashHex)).state).toBe("unknown");
    await client.submitSignedIntent(submitted.signed, session);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[2]![1]?.body).toBe(fetchFn.mock.calls[0]![1]?.body);
    response = { intentHashHex: submitted.tx.intentHashHex, state: "confirmed", signature, slot: 100, confirmationStatus: "confirmed" };
    expect((await client.intentStatus(submitted.tx.intentHashHex)).state).toBe("confirmed");
    response = { ...response, intentHashHex: "00".repeat(32) };
    await expect(client.intentStatus(submitted.tx.intentHashHex)).rejects.toThrow(/receipt/);
    response = { ...response, intentHashHex: submitted.tx.intentHashHex, slot: undefined };
    await expect(client.intentStatus(submitted.tx.intentHashHex)).rejects.toThrow(/evidence/);
    submitted.signed.intent.inMint.fill(8);
    await expect(client.submitSignedIntent(submitted.signed, session)).rejects.toThrow(/mutated/);
  });

  it("snapshots mutable intent fields while an asynchronous signer is waiting", async () => {
    const session = softwareSession(), pocket = derivePocket(23n, new Uint8Array(32).fill(1));
    const params = { nonce: 7n, inMint: new Uint8Array(32).fill(2), inMax: 10n, outMint: new Uint8Array(32).fill(3), outMin: 9n, deadlineSlot: 500n };
    let release!: () => void;
    const pending = signIntent(pocket, { ...session, async sign(digest) {
      const message = digest.slice(); digest.fill(0);
      await new Promise<void>(resolve => { release = resolve; });
      return session.sign(message);
    } }, params);
    pocket.address.fill(4); params.inMint.fill(5); params.outMint.fill(6); release();
    const signed = await pending;
    expect(bytesToHex(intentHash(signed.intent))).toBe(bytesToHex(signed.hash));
    expect(ed25519.verify(signed.signature.signature, signed.hash, session.key32)).toBe(true);
    expect(signed.intent.inMint).toEqual(new Uint8Array(32).fill(2));
  });
});
