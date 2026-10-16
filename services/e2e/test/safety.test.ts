import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

describe("V2 local validator harness", () => {
  it("disables the historical devnet runner for the incompatible V2 candidate", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/devnet-fill.js", import.meta.url))], {
      env: { ...process.env, RPC_URL: "http://127.0.0.1:1", PAYER_KEYPAIR: "never-read.json" }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("V2 has no verified devnet deployment");
  });

  it("refuses funded payer configuration before reading a key or contacting RPC", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/run.js", import.meta.url))], {
      env: { ...process.env, PAYER_KEYPAIR: "a-key-file-that-must-never-be-read.json", RPC_URL: "http://127.0.0.1:1",
        JUPITER_FIXTURE_DIR: "a-fixture-directory-that-must-never-be-read" },
      encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("funded payer keys are not accepted");
    expect(result.stderr).not.toMatch(/ENOENT|ECONNREFUSED/);
  });

  it("refuses a nonlocal RPC before network access", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/run.js", import.meta.url))], {
      env: { ...process.env, PAYER_KEYPAIR: "", RPC_URL: "https://rpc.example.invalid" }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a loopback local validator");
  });

  it("refuses public genesis behind a loopback RPC proxy before any mutating RPC", async () => {
    const methods: string[] = [];
    const server = createServer(async (req, res) => {
      const parts: Buffer[] = []; for await (const part of req) parts.push(part);
      const rpc = JSON.parse(Buffer.concat(parts).toString()); methods.push(rpc.method);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("no address");
    try {
      await expect(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../dist/run.js", import.meta.url))], {
        env: { ...process.env, PAYER_KEYPAIR: "", RPC_URL: `http://127.0.0.1:${addr.port}`,
          JUPITER_FIXTURE_DIR: "a-fixture-directory-that-must-never-be-read" }, timeout: 15_000,
      })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("refuses public-chain genesis") });
      expect(methods).toEqual(["getGenesisHash"]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
