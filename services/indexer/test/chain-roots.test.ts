import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Connection, SystemProgram } from "@solana/web3.js";
import { REGISTRY } from "@ghostlink/service-kit";
import { ROOT_HISTORY_SIZE, TREE_DEPTH } from "@ghostlink/common";
import { ChainRoots } from "../src/chain-roots.js";

describe("on-chain root reconciliation", () => {
  it("refreshes cached negatives and rejects an account with the wrong owner", async () => {
    const root = Buffer.alloc(32, 7);
    const fresh = Buffer.alloc(8 + 8 + 32 * TREE_DEPTH + 32 * ROOT_HISTORY_SIZE);
    createHash("sha256").update("account:TreeState").digest().subarray(0, 8).copy(fresh);
    const old = Buffer.from(fresh);
    root.copy(fresh, 8 + 8 + 32 * TREE_DEPTH);
    const account = (data: Buffer, owner = REGISTRY) => ({ owner, data });
    const connection = { getAccountInfo: vi.fn().mockResolvedValueOnce(account(old)).mockResolvedValueOnce(account(fresh)) };
    const roots = new ChainRoots(connection as unknown as Connection);
    expect(await roots.contains("registry", root)).toBe(true);
    expect(connection.getAccountInfo).toHaveBeenCalledTimes(2);
    connection.getAccountInfo.mockResolvedValue(account(fresh, SystemProgram.programId));
    await expect(new ChainRoots(connection as unknown as Connection).contains("registry", root)).rejects.toThrow(/invalid/);
  });
});
