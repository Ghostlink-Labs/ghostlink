# Indexer recovery and operations

The hosted indexer rebuilds registry/census trees and derived Pocket history from **finalized** RPC transactions. It captures one chain-head slot per scan, stages history in a scoped SQLite spool, and applies it in chronological order. Newer transactions wait for the next scan. The SDK must still verify served roots and current authorization against the chain; the indexer does not grant bot permission.

## Catch-up and consistency

Each tick admits a bounded number of signature pages and transactions. Pagination progress survives restart, including pages collected before an application checkpoint exists. A saved cursor must actually appear in the provider's history: a short page that omits it fails closed. Repeated pages/signatures, descending-order violations, conflicting slots/status, malformed boundaries and contradictory same-slot ordering are refused. Transactions shared by several programs are processed once with the merged ordering constraints.

Scanning completes for every configured program before application starts. Within ascending slots, the indexer topologically orders constraints from the program lists; a tick can stop partway through that ordered work. Only one bounded slot group is loaded at a time. The whole backlog is not loaded into a JavaScript Map.

Successful transaction reads must match the requested signature and saved slot. Missing metadata/logs, an explicit truncation marker or incomplete invocation framing stops progress. Failed transactions contribute no events. Every successful event application and cursor update is committed in the same SQLite FULL transaction as removal from the pending spool. An event or disk-write failure restores the previous in-memory state. A process exit cannot durably dequeue a transaction without its derived checkpoint.

The hosted `/webhook` requires the configured shared secret and returns HTTP 202 as a polling hint. It does **not** apply webhook logs to checkpoint state. This prevents late webhook delivery from reordering Pocket state around the ordered poller. The lower-level in-process server still supports direct fixture/offline ingestion, which has no hosted ordering/readiness guarantee.

RPC pagination is provider evidence, not a proof that every historical transaction was returned. Fresh bootstrap needs an archival provider covering the deployment's complete history. Keep independent root/history reconciliation as a release gate. Do not reset cursors or delete state to conceal missing history.

## Configuration and migration

Use Node 22 and private paths outside version control:

| Variable | Meaning |
| --- | --- |
| `INDEXER_GENESIS_HASH` | Independently approved chain identity |
| `RPC_ENDPOINTS_PATH` or `RPC_URL` | Approved transport providers; see [RPC operations](RPC-OPERATIONS.md) |
| `INDEXER_STATE_PATH` | Durable SQLite checkpoint and scan spool |
| `INDEXER_STATE_KEY_PATH` | Exactly 32 raw random bytes from the operator's secret system |
| `POLL_MS` | Poll interval, default 5,000 ms; accepted range 50–30,000 |
| `INDEXER_PAGES_PER_TICK` | Default 4, maximum 100 |
| `INDEXER_TRANSACTIONS_PER_TICK` | Default 32, maximum 1,000 |
| `INDEXER_TICK_BUDGET_MS` | Admission time budget, default 10,000 ms, maximum 30,000; an already admitted RPC finishes under the transport deadline |
| `INDEXER_PACE_MS` | Delay before page/transaction reads, default 120 ms, range 0–1,000 |
| `WEBHOOK_SECRET`, `PORT` | Optional authenticated polling hints; HTTP port defaults to 8787 |

Hosted startup requires RPC and state configuration. It refuses legacy `PERSIST_PATH` and any `INGEST_COMMITMENT` other than `finalized`. This is a coordinated migration: preserve old state, rebuild/check the finalized roots and history independently, then switch clients. A JSON snapshot is not silently imported as a trusted production checkpoint. The existing V1 deployment is unchanged.

State is scoped to the genesis, ordered program IDs and commitment. Checkpoint, scan-position and ownership records are authenticated/encrypted; public signatures, slots and ordering indexes are stored as SQLite metadata. Restrict the whole directory and its WAL files. This does not hide on-chain transaction metadata or provide an independently verifiable history archive. Wrong scope/key and marked backup-restoration epochs are refused.

A fenced 90-second ownership lease permits one active worker. The entry point renews it every 15 seconds. Another worker is refused while it is valid; an expired worker cannot commit after takeover. Graceful shutdown releases it. After a crash, wait for lease expiry rather than deleting the database. Correct host time and local durable storage are prerequisites. Independent database copies do not coordinate ownership and are not a high-availability deployment.

The default envelope is 1,000,000 pending transactions, up to three times that many scanned program/signature memberships, 4,096 transactions in one ordered slot group and a 64 MiB serialized derived checkpoint. Each transaction is limited to 2,048 log lines, 64 KiB of log text and 256 decoded events. Capacity exhaustion refuses further work; it never discards history. The in-memory Merkle trees and derived checkpoint remain bounded by that checkpoint envelope, and checkpoint writes currently serialize derived state. Measure throughput, startup time and storage at the intended pilot size before production; this is not a claim of unlimited history or high-volume ingestion capacity. Retention, scalable incremental state storage, migration/backup/key rotation and rollback reconciliation remain release work.

## Readiness and shutdown

`/health` preserves diagnostic liveness/polling status. `/ready` returns 200 only when this worker still owns state, its last scan completed without a polling error, and both successful ingestion and observed head advancement are less than 30 seconds old. Catch-up, stale/frozen head, lost ownership and drain return 503. No fresh head does not prove an RPC is dishonest, but it is insufficient readiness evidence. These checks do not independently verify provider history completeness or current root-ring membership.

SIGTERM/SIGINT stops new webhooks and polling admission. An already admitted page or transaction finishes and checkpoints; the service waits up to 30 seconds before forced termination. The durable checkpoint remains authoritative after either exit. The process does not save an unrelated final JSON snapshot while an asynchronous poll is still running.

Finality introduces delay. High registry/census turnover can evict an indexed root from the program's accepted root ring before proof submission. Test root-ring availability, owner onboarding latency and required ingestion throughput under representative traffic; do not remove finality or change the ring merely to make a readiness endpoint green. Confirmed-fork rollback and production archival/provider guarantees are separate release requirements.

## Reproduction

```sh
pnpm --filter @ghostlink/indexer... build
pnpm --filter @ghostlink/indexer test
# Unix signal drill, also run by Linux CI:
node services/indexer/test/drain-drill.mjs
# Requires prepared disposable validator/program/circuit artifacts:
INDEXER_FINALIZED_DRILL=1 bash scripts/localnet-e2e.sh
```

Tests cover missing/truncated logs, repeated pages, bounded multi-tick history, restart during pagination, same-slot cross-program ordering, a real child exit after checkpoint, actual SQLite rollback, ownership takeover/fencing, readiness and hosted webhook hints. The Unix process drill holds a transaction read, sends SIGTERM, releases the response, then checks that restart retains the cursor without replay. The local validator verifies actual tree roots and the complete SDK/pocket flow. Live archival acceptance, production load/soak, alerts, coordinated migration and the [mainnet release gates](MAINNET-READINESS.md) remain open.

RPC semantics: [signature pagination](https://solana.com/docs/rpc/http/getsignaturesforaddress) and [transaction identity and metadata](https://solana.com/docs/rpc/http/gettransaction).
