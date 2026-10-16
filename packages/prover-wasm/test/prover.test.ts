import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createProver } from "../src/index.js";

const fullProve = vi.hoisted(() => vi.fn(async () => ({ proof: {}, publicSignals: [] })));
vi.mock("snarkjs", () => ({ groth16: { fullProve } }));

const bytes = new Uint8Array([1, 2, 3]);
const hash = createHash("sha256").update(bytes).digest("hex");
const artifacts = { wasmUrl: "https://artifacts.test/circuit.wasm", zkeyUrl: "https://artifacts.test/circuit.zkey" };
const fetchFn = vi.fn(async () => new Response(bytes));

beforeEach(() => { fullProve.mockClear(); fetchFn.mockClear(); });

describe("prover artifact integrity", () => {
  it("checks the configured hash even when another circuit cached the same URL", async () => {
    const prover = createProver({
      login: artifacts,
      owner: { ...artifacts, wasmSha256: "00".repeat(32), zkeySha256: hash },
      fetchFn: fetchFn as typeof fetch,
    });
    await prover.prove("login", {});
    await expect(prover.prove("owner", {})).rejects.toThrow(/integrity check failed/);
    expect(fullProve).toHaveBeenCalledTimes(1);
  });

  it("shares verified downloads, refuses malformed pins, and retries failed downloads", async () => {
    let fail = true;
    const fetchRetry = vi.fn(async () => {
      if (fail) throw new Error("offline");
      return new Response(bytes);
    });
    const pinned = { ...artifacts, wasmSha256: hash, zkeySha256: hash };
    const prover = createProver({ login: pinned, owner: { ...pinned, wasmSha256: "" }, fetchFn: fetchRetry as typeof fetch });
    await expect(prover.prove("login", {})).rejects.toThrow(/offline/);
    fail = false;
    await Promise.all([prover.prove("login", {}), prover.prove("login", {})]);
    expect(fetchRetry).toHaveBeenCalledTimes(4); // failed pair + one shared retry pair
    await expect(prover.prove("owner", {})).rejects.toThrow(/invalid SHA-256/);
    expect(fullProve).toHaveBeenCalledTimes(2);
  });
});
