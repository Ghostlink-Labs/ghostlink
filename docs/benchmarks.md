# Benchmarks

Measured on the dev machine (Windows 11, WSL2 for chain-side work) during
the v1 build. Phone numbers are the M1 gate's missing piece — measure on a
mid-range Android and an iPhone before calling M1 done.

## Proving (snarkjs, dev zkeys)

| Circuit | Constraints | This machine | Plan's target |
| --- | --- | --- | --- |
| `login` | 30,138 | ~1.7 s (Node 22) · **2.41 s in-browser** (Chromium, 20 cores, avg of 3) | 1–2 s laptop, 2–5 s phone |
| `owner` | 15,248 | ~0.9 s (Node 22) | — |

Phone proving: **not yet measured**. Benchmark `@ghostlink/prover-wasm` in
your own browser integration on a mid-range Android and an iPhone, and
record the numbers with the device names. The private benchmark UI is
not distributed in this technology repository.
rapidsnark-wasm is the planned fallback if a phone exceeds 5 s.

## On-chain

| Operation | Budget requested | Notes |
| --- | --- | --- |
| `open_session` | 400,000 CU | Groth16 verify (~80–110k per groth16-solana's own benches) + Poseidon re-derivations + account init |
| `fill_begin` / `fill_end` | default (200k tx) | whole happy-path fill tx fits the default budget in the e2e |
| registry `register` | default | 26 Poseidon syscalls for the append + base58 message rebuild |

## End-to-end (localnet, real validator)

`scripts/localnet-e2e.sh`: register → snapshot → prove → verify →
open_session → Blink deposit → solver fill → owner-proof sweep, all
passing in roughly a minute including validator boot.
