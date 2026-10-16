# Devnet

> V2 candidate notice: this page records the preserved **V1** deployment. The commands and results below are historical V1 procedures, not runnable V2 release instructions. The current development branch changes the login proof and session instruction and is localnet-only. Both devnet runners refuse to proceed; the local validator runner refuses funded payer keys and public-chain genesis. Do not send V2 proofs or deploy V2 binaries to these existing IDs. See [ADR 0003](adr/0003-session-authorization-v2.md). The private live app remains on its compatible V1 code.

> Updated 2026-10-16: the reviewed Pocket program is deployed at a fresh devnet address. The old program and its seven legacy accounts were preserved. Clients in this release target the new 2,089-byte layout; they do not migrate or reinterpret older accounts. See [ADR 0002](adr/0002-open-source-review.md).

Devnet is Solana's public test network. This deployment uses development proving keys and test tokens. Mainnet requires separate security review, a production key ceremony and explicit release authorization.

## Current devnet program IDs

| Program | ID |
| --- | --- |
| registry | `54EZ5ZkUANBs1SfQoXaU5EQSR8VAaD3XDtKEZGp6KjRv` |
| census | `CvRA16GAa5ynUE3bzgMWuPYTbHLsdvyBydJoZVft5x9d` |
| pocket | `HbSux9YnTupzNiRUwdR2mjTpJJryx25RV42wry4kCwiH` |

The previous Pocket program, `5nLdCXFhJDmBbE6VfxgkLxLRR5Vk516G95U3VoQobPCa`, remains unchanged. Existing pockets belong to that deployment; changing an SDK default does not move their accounts or balances. Use a compatible legacy client to inspect those accounts.

The fresh deployment transaction is `2bFvZZrF4nuFzf8wnbJFafCX5gc7M1vF99GcdkUM2VNSV4ncJc2hYb5QyocsgxJQ7PJbjKXs62hYKZgsckZbA1dM`. Registration, census snapshot, proof generation and verification, opening a pocket, funding and owner-proof sweep passed against this release. The test pocket was `7wf64QrVG2RcjwVmeCN9xwmM9ztNkFcY3C5DKarZTVMm`. Eight LiteSVM flows and the regenerated circuit fixtures also passed. Live oracle swap execution was skipped in this release check; the historical fill result below is not evidence for the new deployment.

Deploy keypairs live outside the repo in `~/.ghostlink/keys/` (WSL). The registration message binds `cluster:devnet` (a compile-time feature of the registry program), so devnet signatures can never replay on mainnet.

## Deploying

The script below is legacy operator tooling. Program keypairs matching these IDs are held privately and are not supplied with the public source. It skips already-deployed programs; it does not upgrade or migrate them. The script verifies the RPC genesis hash is devnet before any deployment. Override the key directory with `GHOSTLINK_PROGRAM_KEY_DIR` and the payer path with `GHOSTLINK_DEPLOYER_KEYPAIR`.

```bash
# fund the deployer (~7 SOL covers all three programs)
solana airdrop 5 $(solana-keygen pubkey ~/.ghostlink/keys/deployer.json) -u devnet
# the CLI faucet rate-limits aggressively; https://faucet.solana.com
# (GitHub sign-in) is the reliable fallback

scripts/devnet-deploy.sh   # deploys whatever is missing, then runs the
                           # identity-path e2e (register → … → open → fund → sweep)
```

## What runs on devnet vs localnet

| Flow | Localnet (`scripts/localnet-e2e.sh`) | Devnet (`scripts/devnet-deploy.sh`) |
| --- | --- | --- |
| register / snapshot / prove / verify / open_session | ✓ | ✓ |
| fund through the Blink | ✓ | ✓ |
| oracle-checked fill | ✓ (fake Pyth accounts at genesis) | skipped by `devnet-deploy.sh`; run `services/e2e/dist/devnet-fill.js` (below) for the real thing against live Pyth prices |
| owner-proof sweep home | ✓ | ✓ |

## The oracle-checked fill with real Pyth prices

`node services/e2e/dist/devnet-fill.js` runs the whole journey with
`SKIP_FILL=0`. It binds the pocket's two test mints to the real Pyth
SOL/USD and USDC/USD feed ids in the policy, so `fill_begin`/`fill_end`
value the swap against live market prices and enforce the slippage floor
on-chain exactly as they would on mainnet.

Where the prices come from: Pyth's **sponsored push feeds** — `PriceUpdateV2`
accounts under the push-oracle program `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`,
owned by the receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`, that Pyth
keeps updated on devnet at no cost. The runner picks the freshest shard for
each feed (`services/e2e/scripts/check-push-feed.mjs` inspects them). We do
not pull updates from Hermes: its `/v2/updates` endpoint requires an API
key as of October 2026, and posting updates ourselves would only add a
dependency the product does not need — on mainnet the solver's price
account is whatever the pocket policy pinned.

Timing: the pocket rejects prices older than 60 s. SOL/USD refreshes every
few seconds, but USDC/USD only on a ~5 minute heartbeat (or a 0.1 % move), so
the runner waits for both feeds to be ≤ 40 s old, recomputes `out_min` from
the live SOL/USD price (`$25 → lamports × 1.004`), then fires the fill.
Expect a wait of up to five minutes before the fill step.

Costs per run (devnet SOL): ~0.02 to the wallet, ~0.06 to the solver, plus
rent for the pocket and token accounts; the deployer needs ≥ 0.3 SOL spare.

Last verified 2026-10-15: pocket `CRysbuX8STrfxrNHMpFJxRzqRQR9g3PnZ28EBTdRXAKM`,
fill at SOL/USD $105.10, `out_min` 238 820 943 lamports, pocket credited
atomically and swept home with the owner proof.

## Running services against devnet

Each service takes `RPC_URL=https://api.devnet.solana.com` (a Helius devnet URL is better behaved for the indexer's polling). Keys via `GHOSTLINK_RELAYER_KEYPAIR` / `GHOSTLINK_SOLVER_KEYPAIR`; never in the repo.

| Service | Variable | Meaning |
| --- | --- | --- |
| indexer | `PERSIST_PATH` | JSON snapshot incl. poller cursors; a restart resumes instead of replaying |
| indexer | `WEBHOOK_SECRET` | enables `POST /webhook`; Helius sends it as the webhook's `authHeader` |
| indexer | `POLL_MS` | polling interval (default 15000) |
| indexer | `INGEST_COMMITMENT` | `confirmed` (default) or `finalized` |
| relayer | `RELAYER_DAILY_BUDGET_LAMPORTS` | rolling 24 h spend ceiling (default 2 SOL) |
| relayer | `RELAYER_BUDGET_PATH` | durable rolling spend snapshot; one payer process per file |
| relayer | `RELAYER_ALLOWED_ORIGINS` | comma-separated origins whose pockets it creates; unset = any |
| relayer, solver | `TRUST_PROXY=1` | honour `X-Forwarded-For` — only behind your own proxy |
| solver | `PRICE_ACCOUNTS` | JSON map mint → Pyth price-update account |
| solver | `SOLVER_MAX_SPREAD_BPS` | how far above the input's value a fill may go (default 100) |
| solver | `SOLVER_ALLOW_UNPRICED=1` | fill output mints with no price (NFT-style) |
| solver | `SOLVER_CREATE_POCKET_ATA=1` | pay rent for missing pocket output accounts (off: farmable) |
| actions | `BASE_URL`, `CLUSTER` | public origin for Blink links; `devnet` or `mainnet-beta` |
| watcher | `NOTIFY_WEBHOOK`, `LARGE_FILL_USD_E6` | alert sink and large-fill threshold |
| watcher | `GHOSTLINK_WATCHER_KEYPAIR` | fee payer for cranking `execute_change` once a timelock has elapsed |
| watcher | `WATCHER_STATE_PATH` | delivered cursor and pending timelocks, persisted across restarts |

The indexer polls politely on public RPC: an initial backfill, then every
15 s (`POLL_MS`) it asks only for signatures newer than the last one it saw
per program, so a quiet tick is three cheap calls and never trips the
429 limiter in ordinary quiet operation; provider limits can still be reached.

Without the persistence paths, relayer spend accounting and watcher progress reset on restart. The watcher backfills available history on first start. Persistent files need a single writer; they are not distributed locks. Indexer pocket webhooks require a transaction signature (`signature` or Helius `transaction.signatures[0]`) for deduplication. Raw logs without a signature may only ingest tree events. Confirmed-fork rollback and out-of-order unique pocket metadata remain limitations; prefer finalized ingestion where appropriate.
