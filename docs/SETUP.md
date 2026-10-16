# Setup

The TypeScript workspaces run on Node. Solana binaries and circuit compilation use Linux; Windows developers can use WSL. Use test assets only.

## Toolchain

| Tool | Version |
| --- | --- |
| Node | 22, as in `.nvmrc` |
| pnpm | 10.33.2, as in `package.json` |
| Rust | 1.97.1, as in `rust-toolchain.toml` |
| Agave/Solana | 3.0.x; CI installs published 3.0.14 with an archive checksum |
| SBF platform tools | v1.52 |
| circom | 2.2.3 |
| snarkjs | Resolved by `pnpm-lock.yaml` |

Install circom from the official [iden3 repository](https://github.com/iden3/circom). Use the lockfiles. Do not copy `node_modules` between Windows and Linux: platform-specific dependencies differ. Prefer a separate Linux checkout when building everything there.

## TypeScript and committed program fixtures

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm typecheck
pnpm test

# Linux / WSL; builds registry, census, pocket and the test CPI caller.
bash scripts/build-programs.sh
bash scripts/test-programs.sh
```

The committed JSON proofs and verifying keys are enough for Rust/LiteSVM tests. You do not need to regenerate setup keys first. Proving through the SDK needs local or hosted circuit artifacts.

## Fresh local proving setup

This step creates insecure development proving keys. It changes generated public fixtures and both Rust and server verifying keys, which must be kept together. Run it in a disposable development branch; never use its output for production.

```bash
pnpm --filter @ghostlink/common build
bash scripts/build-circuits.sh
pnpm --filter @ghostlink/circuits test
bash scripts/build-programs.sh
bash scripts/test-programs.sh
pnpm -r build
bash scripts/localnet-e2e.sh
```

The full test starts a fresh local validator, uses fake oracle accounts and disposable keys, runs register → snapshot → prove → verify → open → fund → fill → sweep, then stops. It refuses an already-running RPC at port 8899. Each run has a unique temporary ledger directory printed at startup; it does not erase a previous ledger.

`CARGO_TARGET_DIR` is supported by the build and test scripts. It must identify the same target directory when building and testing, because LiteSVM loads its `deploy/*.so` files.

## Persistent local services

After the fresh-setup sequence above, start the stack in persistent mode:

```bash
GHOSTLINK_KEEP_RUNNING=1 bash scripts/localnet-e2e.sh
```

After the end-to-end test passes, it leaves the validator and loopback-only services running: RPC 8899, indexer 8787, relayer 8788, solver 8789 and Actions 8790. Stop with Ctrl+C.

If those service ports are occupied, set `GHOSTLINK_DEMO_PORT_BASE` to a free starting port; the four services use that port and the next three. This legacy variable name configures the reference services; no demo application is distributed here. Point your SDK integration at the printed service URLs. The local validator loads the default registry build, whose registration tag is `devnet`.

The headless runner provides a working integration example in `services/e2e/src/run.ts`. It covers registration, claims, funding, fill and sweep with disposable test assets.

## Credentials and identity

Keep keypairs and environment files outside version control. The devnet scripts require program keypairs matching the declared program IDs, which are not supplied in this public repository. See [DEVNET](DEVNET.md).
