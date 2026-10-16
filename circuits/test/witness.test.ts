/**
 * Witness tests against the shared fixture vectors (build plan, test layer 2).
 *
 * The compiled circuit wasm asserts every constraint while calculating a
 * witness, so "calculates" means the inputs satisfy the circuit and
 * "throws" means they violate it. Requires circuits/build from
 * scripts/build-circuits.sh; tests skip (loudly) if it is missing.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - snarkjs ships no types
import * as snarkjs from "snarkjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vectors = JSON.parse(
  readFileSync(join(root, "packages/common/fixtures/vectors.json"), "utf8"),
);

const loginWasm = join(root, "circuits/build/login_js/login.wasm");
const ownerWasm = join(root, "circuits/build/owner_js/owner.wasm");
const built = existsSync(loginWasm) && existsSync(ownerWasm);

const tmp = mkdtempSync(join(tmpdir(), "ghostlink-wtns-"));
const wtns = (name: string) => join(tmp, `${name}.wtns`);

async function calculate(wasm: string, input: Record<string, unknown>, name: string) {
  await snarkjs.wtns.calculate(input, wasm, wtns(name));
}

const loginInput = () => ({ ...vectors.circuits.login.public, ...vectors.circuits.login.private });
const ownerInput = () => ({ ...vectors.circuits.owner.public, ...vectors.circuits.owner.private });

describe.skipIf(!built)("login circuit", () => {
  it("accepts the fixture inputs", async () => {
    await calculate(loginWasm, loginInput(), "login-ok");
  });

  it("rejects a wrong registry root", async () => {
    const input = loginInput();
    input.registry_root = "12345";
    await expect(calculate(loginWasm, input, "login-badroot")).rejects.toThrow();
  });

  it("rejects an app_id for a different domain", async () => {
    const input = loginInput();
    input.app_id = vectors.identity.ownerTag; // a valid field element, wrong derivation
    await expect(calculate(loginWasm, input, "login-badapp")).rejects.toThrow();
  });

  it("rejects a balance below the threshold", async () => {
    const input = loginInput();
    input.threshold = (BigInt(vectors.census.amount) + 1n).toString();
    await expect(calculate(loginWasm, input, "login-poor")).rejects.toThrow();
  });

  it("rejects a stale snapshot", async () => {
    const input = loginInput();
    input.min_slot = (BigInt(vectors.census.slot) + 1n).toString();
    await expect(calculate(loginWasm, input, "login-stale")).rejects.toThrow();
  });

  it("ignores census garbage when the holdings claim is off", async () => {
    const input = loginInput();
    input.claim_holdings = "0";
    input.census_root = "999";
    input.amount = "0";
    input.threshold = "1000000";
    input.slot = "0";
    await calculate(loginWasm, input, "login-noclaim");
  });

  it("rejects a non-bit claim flag", async () => {
    const input = loginInput();
    input.claim_holdings = "2";
    await expect(calculate(loginWasm, input, "login-flag2")).rejects.toThrow();
  });

  it("rejects a wrong secret for the registered commitment", async () => {
    const input = loginInput();
    input.s = (BigInt(input.s as string) + 1n).toString();
    await expect(calculate(loginWasm, input, "login-bads")).rejects.toThrow();
  });
});

describe.skipIf(!built)("owner circuit", () => {
  it("accepts the fixture inputs", async () => {
    await calculate(ownerWasm, ownerInput(), "owner-ok");
  });

  it("rejects a wrong domain", async () => {
    const input = ownerInput();
    input.domain_hash = "777";
    await expect(calculate(ownerWasm, input, "owner-baddomain")).rejects.toThrow();
  });

  it("rejects a leaf outside the tree", async () => {
    const input = ownerInput();
    input.reg_index = "2"; // our leaf is at index 0
    await expect(calculate(ownerWasm, input, "owner-badindex")).rejects.toThrow();
  });
});

if (!built) {
  it("circuits are not built", () => {
    console.warn("circuits/build missing — run scripts/build-circuits.sh (WSL/Linux) first");
    expect(built).toBe(false);
  });
}

process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
