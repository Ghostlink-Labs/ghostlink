/** The Blink endpoint must derive destinations only from the app id. */
import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { POCKET } from "@ghostlink/service-kit";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vectors = JSON.parse(
  readFileSync(join(root, "packages/common/fixtures/vectors.json"), "utf8"),
);
const appIdHex = BigInt(vectors.pdas.pocket.appId).toString(16).padStart(64, "0");

async function withServer<T>(fn: (base: string) => Promise<T>, connection = new Connection("http://127.0.0.1:1")): Promise<T> {
  const server = buildServer({
    connection,
    baseUrl: "https://actions.test",
  });
  server.listen(0);
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe("actions endpoint", () => {
  it("serves metadata whose pocket matches the fixture PDA", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/actions/fund/${appIdHex}`);
      expect(res.status).toBe(200);
      const meta = (await res.json()) as { description: string; type: string; pocket: string };
      expect(meta.type).toBe("action");
      const pocket = vectors.pdas.pocket.address as string;
      expect(meta.pocket).toBe(pocket);
      expect(meta.description).toContain(pocket);
    });
  });

  it("rejects malformed app ids", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/actions/fund/nothex`);
      expect(res.status).toBe(400);
    });
  });

  it("serves the actions.json routing file", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/actions.json`);
      const rules = (await res.json()) as { rules: { pathPattern: string }[] };
      expect(rules.rules[0]!.pathPattern).toBe("/actions/**");
    });
  });

  it("refuses prefunded unopened PDAs, then builds a deposit only for the initialized pocket", async () => {
    const user = Keypair.generate().publicKey;
    let opened = false;
    const data = Buffer.concat([createHash("sha256").update("account:Pocket").digest().subarray(0, 8), Buffer.from(appIdHex, "hex")]);
    const connection = {
      getAccountInfo: async () => ({ owner: opened ? POCKET : SystemProgram.programId, data: opened ? data : Buffer.alloc(0), executable: false }),
      getLatestBlockhash: async () => ({ blockhash: SystemProgram.programId.toBase58() }),
    } as unknown as Connection;
    await withServer(async (base) => {
      const post = () => fetch(`${base}/actions/fund/${appIdHex}?amount=1`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: user.toBase58() }),
      });
      expect((await post()).status).toBe(400);
      opened = true;
      const response = await post();
      expect(response.status).toBe(200);
      const tx = Transaction.from(Buffer.from((await response.json()).transaction, "base64"));
      expect(tx.instructions[0]?.keys[1]?.pubkey.toBase58()).toBe(vectors.pdas.pocket.address);
      expect(tx.feePayer?.equals(user)).toBe(true);
    }, connection);
  });
});
