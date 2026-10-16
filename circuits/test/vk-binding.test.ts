/**
 * Every public input must take part in at least one constraint. If circom's
 * optimizer ever folded away a binding such as `x <== input * 1`, that
 * input's IC point in the verifying key would be the point at infinity and
 * a proof would verify for ANY value of it — a replayable session key,
 * home address or action digest. Two guards: the IC points are finite, and
 * the committed proofs stop verifying when any public signal changes.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - snarkjs ships no types
import * as snarkjs from "snarkjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const keys = join(root, "circuits/keys");
const load = (name: string) => JSON.parse(readFileSync(join(keys, name), "utf8"));

const INFINITY = (p: string[]) => p[0] === "0" && p[1] === "1" && p[2] === "0";

const circuits = [
  { name: "login", vk: "login_vk.json", proof: "login_proof.json", publicInputs: 12 },
  { name: "owner", vk: "owner_vk.json", proof: "owner_proof.json", publicInputs: 4 },
];

describe("verifying keys bind every public input", () => {
  for (const c of circuits) {
    const present = existsSync(join(keys, c.vk)) && existsSync(join(keys, c.proof));

    it(`${c.name}: every IC point is a finite curve point`, () => {
      expect(present, `${c.vk} / ${c.proof} missing — run scripts/build-circuits.sh`).toBe(true);
      const vk = load(c.vk);
      expect(vk.nPublic).toBe(c.publicInputs);
      expect(vk.IC).toHaveLength(c.publicInputs + 1);
      for (const [i, p] of (vk.IC as string[][]).entries()) {
        expect(INFINITY(p), `IC[${i}] is the point at infinity: public input ${i} is unconstrained`).toBe(false);
        expect(p[2]).toBe("1");
      }
    });

    it(`${c.name}: changing any public signal breaks the committed proof`, async () => {
      expect(present).toBe(true);
      const vk = load(c.vk);
      const { proof, publicSignals } = load(c.proof) as { proof: object; publicSignals: string[] };
      expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
      for (let i = 0; i < publicSignals.length; i++) {
        const mutated = [...publicSignals];
        mutated[i] = (BigInt(mutated[i]!) + 1n).toString();
        expect(
          await snarkjs.groth16.verify(vk, mutated, proof),
          `public signal ${i} is not bound by the proof`,
        ).toBe(false);
      }
    });
  }
});
