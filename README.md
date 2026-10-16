# GhostLink

Experimental zero-knowledge identity and policy-controlled spending pockets for Solana.

GhostLink proves membership in a wallet registry and, optionally, a historical token balance without putting the wallet address in the login proof. A per-origin pocket holds funds separately from the main wallet. Signed intents constrain supported swaps; owner proofs authorize recovery and delayed home/policy changes.

**Development and test networks only.** This repository uses throwaway Groth16 setup keys and has not had an independent security audit. It is not ready for real funds or a mainnet deployment. Read [the threat model](docs/THREAT-MODEL.md) before integrating.

## What is implemented

- Anchor registry, census and pocket programs, plus a shared Groth16 verifier.
- Circom login and owner circuits, shared encoding vectors and public proof fixtures.
- TypeScript SDK, React bindings, browser prover and server proof verifier.
- Indexer, relayer, inventory-based test solver, funding Actions endpoint and recovery watcher.

This repository publishes the reusable technology only. The website, dApp, prototypes, product designs and brand assets are not included. React bindings are unstyled integration components.

The SDK currently receives the identity secret in the caller's JavaScript context. It does not provide an isolated wallet extension or origin-enforcing broker. Only trusted code may hold that secret. Backend authentication also needs a fresh, single-use challenge signed by the proof-bound session key; checking a proof alone is insufficient.

Pocket state, home addresses, deposits, withdrawals and transactions are public. Funding and recovery can link wallets and pockets. This is not anonymous payment infrastructure.

## Develop

Integration work is tracked in [mainnet readiness and the compatibility matrix](docs/MAINNET-READINESS.md). For bot/public-key authorization, see [integration boundaries](docs/INTEGRATIONS.md) and [SDK installation](packages/sdk/README.md). This development SDK refuses mainnet configuration; it does not yet support unattended new-token sniping or Token-2022 settlement.

Use Node 22 and the pnpm version in `package.json`:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm typecheck
pnpm test
```

Programs build under Linux or WSL:

```bash
bash scripts/build-programs.sh
bash scripts/test-programs.sh
```

These program tests use committed public fixtures. A fresh local proving setup is a separate development operation that changes generated fixtures and verifying keys. Follow [SETUP](docs/SETUP.md) for circuits and the full validator test.

## Repository map

| Path | Contents |
| --- | --- |
| `programs/` | Registry, census, pocket, shared verifier and integration tests |
| `circuits/` | Login/owner circuits and public fixtures |
| `packages/` | Common encodings, SDK, React, prover and verifier |
| `services/` | Indexer, relayer, solver, funding Actions and watcher |
| `docs/` | Setup, protocol decisions, threat model and benchmarks |

Pocket accounts include an administrative nonce and allocate **2,089 bytes**; the previous 2,081-byte layout is unsupported by the updated clients. No existing deployment has been upgraded by this release. See [the migration decision](docs/adr/0002-open-source-review.md).

## Contribute

See [CONTRIBUTING](CONTRIBUTING.md) and [SECURITY](SECURITY.md). Source is licensed under [Apache-2.0](LICENSE). No npm release or hosted service is implied by the workspace package names. The source license does not grant rights to GhostLink trademarks or excluded brand assets.
