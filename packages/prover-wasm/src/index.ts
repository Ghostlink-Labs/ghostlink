/**
 * The device-side prover (build plan section 7: proving stays on the
 * device so the secret never reaches a server).
 *
 * Artifacts (circuit wasm + proving key) are fetched once, checked
 * against pinned SHA-256 integrity hashes (supply-chain control from the
 * threat model), cached, and handed to snarkjs. Use `createProver` in a
 * web worker where possible; proving takes 1–2 s on a laptop, 2–5 s on a
 * phone.
 */
import * as snarkjs from "snarkjs";

export interface CircuitArtifacts {
  wasmUrl: string;
  zkeyUrl: string;
  /** Hex SHA-256 of each artifact; refuse to prove when they mismatch. */
  wasmSha256?: string;
  zkeySha256?: string;
}

export interface ProverConfig {
  login: CircuitArtifacts;
  owner: CircuitArtifacts;
  fetchFn?: typeof fetch;
}

export interface Prover {
  prove(
    circuit: "login" | "owner",
    input: Record<string, string | string[]>,
  ): Promise<{ proof: object; publicSignals: string[] }>;
}

export function createProver(config: ProverConfig): Prover {
  const fetchFn = config.fetchFn ?? fetch;
  const cache = new Map<string, Promise<Uint8Array>>();

  async function load(url: string, expectedSha256?: string): Promise<Uint8Array> {
    if (expectedSha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(expectedSha256)) {
      throw new Error(`invalid SHA-256 integrity hash for ${url}`);
    }
    // The same URL may be configured for multiple circuits. Reuse is only
    // valid under the same integrity requirement, including pinned vs not.
    const key = JSON.stringify([url, expectedSha256?.toLowerCase() ?? null]);
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = download(url, expectedSha256);
    cache.set(key, pending);
    try {
      return await pending;
    } catch (e) {
      cache.delete(key);
      throw e;
    }
  }

  async function download(url: string, expectedSha256?: string): Promise<Uint8Array> {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (expectedSha256) {
      const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      if (hex !== expectedSha256.toLowerCase()) {
        throw new Error(`integrity check failed for ${url}`);
      }
    }
    return bytes;
  }

  return {
    async prove(circuit, input) {
      const art = config[circuit];
      const [wasm, zkey] = await Promise.all([
        load(art.wasmUrl, art.wasmSha256),
        load(art.zkeyUrl, art.zkeySha256),
      ]);
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
      return { proof: proof as object, publicSignals: publicSignals as string[] };
    },
  };
}
