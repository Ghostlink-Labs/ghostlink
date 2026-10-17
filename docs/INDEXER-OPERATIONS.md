# Indexer recovery and operations

The hosted indexer rebuilds registry/census trees and derived Pocket history from **finalized** RPC transactions. It reads both on-chain tree accounts in one contextual request and saves that slot, both leaf counts and both current roots as the scan's authenticated anchor. It stages history in a scoped SQLite spool and applies it in chronological order through that slot. Newer transactions wait for the next scan. The SDK must still verify served roots and current authorization against the chain; the indexer does not grant bot permission.

## Catch-up and consistency

Each tick admits a bounded number of signature pages and transactions. Pagination progress survives restart, including pages collected before the first event is applied. A saved cursor must actually appear in the provider's history: a short page that omits it fails closed. Repeated pages/signatures, descending-order violations, conflicting slots/status, malformed boundaries and contradictory same-slot ordering are refused. Transactions shared by several programs are processed once with the merged ordering constraints.

Scanning completes for every configured program before application starts. Within ascending slots, the indexer topologically orders constraints from the program lists; a tick can stop partway through that ordered work. Only one bounded slot group is loaded at a time. The whole backlog is not loaded into a JavaScript Map.

Successful transaction reads must match the requested signature and saved slot. Missing metadata/logs, an explicit truncation marker or incomplete invocation framing stops progress. Failed transactions contribute no events. Every successful event application and cursor update is committed in the same SQLite FULL transaction as removal from the pending spool. An event or disk-write failure restores the previous in-memory state. A process exit cannot durably dequeue a transaction without its derived checkpoint.

The hosted `/webhook` requires the configured shared secret and returns HTTP 202 as a polling hint. It does **not** apply webhook logs to checkpoint state. This prevents late webhook delivery from reordering Pocket state around the ordered poller. The lower-level in-process server still supports direct fixture/offline ingestion, which has no hosted ordering/readiness guarantee.

Before accepting a completed scan, both rebuilt tree counts and roots must exactly match the saved finalized anchor. A mismatch preserves the active scan and applied checkpoint, does not advance the completed-scan slot, and refuses readiness. The original anchor survives partial-scan restart; a later account read cannot replace it. Missing accounts, wrong owners/discriminators/layouts, invalid counts/cursors/field encodings and regressing RPC contexts are refused. This also catches a falsely empty history result when an on-chain tree is nonempty.

RPC pagination and account responses are still provider evidence. Matching roots verifies the reconstructed tree contents, not every Pocket event, historical binding field, provider honesty or complete business history. Fresh bootstrap needs an archival provider covering the deployment's complete history. Independent provider/business-history reconciliation remains a release gate. Do not reset cursors or delete state to conceal missing history.

## Configuration and migration

Use Node 22 and private paths outside version control:

| Variable | Meaning |
| --- | --- |
| `INDEXER_GENESIS_HASH` | Independently approved chain identity |
| `RPC_ENDPOINTS_PATH` or `RPC_URL` | Approved transport providers; see [RPC operations](RPC-OPERATIONS.md) |
| `INDEXER_STATE_PATH` | Durable SQLite checkpoint and scan spool |
| `INDEXER_STATE_KEY_PATH` | Exactly 32 raw random bytes from the operator's secret system |
| `INDEXER_STATE_ID` | Independently pinned 64-character hexadecimal ID of this initialized database; required on every hosted start |
| `POLL_MS` | Poll interval, default 5,000 ms; accepted range 50–30,000 |
| `INDEXER_PAGES_PER_TICK` | Default 4, maximum 100 |
| `INDEXER_TRANSACTIONS_PER_TICK` | Default 32, maximum 1,000 |
| `INDEXER_TICK_BUDGET_MS` | Admission time budget, default 10,000 ms, maximum 30,000; an already admitted RPC finishes under the transport deadline |
| `INDEXER_PACE_MS` | Delay before page/transaction reads, default 120 ms, range 0–1,000 |
| `WEBHOOK_SECRET`, `PORT` | Optional authenticated polling hints; HTTP port defaults to 8787 |

Hosted startup opens an authenticated **existing** database and checks its encrypted instance ID against `INDEXER_STATE_ID` before acquiring ownership. Missing/empty/wrong-scope files, missing schema, identity, snapshot, progress floor or scan checkpoint are errors. It never creates replacement state. It also refuses legacy `PERSIST_PATH` and any `INGEST_COMMITMENT` other than `finalized`.

Provision an explicit new development rebuild separately, using an exclusive directory:

```sh
INDEXER_GENESIS_HASH=<approved-local-validator-genesis> \
  node services/indexer/dist/initialize.js /private/new-indexer
```

The initializer writes a fresh key, database, scope and final `deployment.json` completion manifest. It makes no network calls and starts no service. Store the manifest's `stateId` independently in operator configuration; do not derive it from whichever database happens to be mounted at startup. Existing directories are refused. Preserve partial output after an interrupted initialization for inspection. Known devnet/mainnet genesis hashes are refused while this candidate has no verified public deployment.

Older SQLite state without these records is also refused, rather than silently upgraded. A legacy in-progress scan without a tree anchor is preserved and refused by the hosted poller; do not invent an anchor from today's accounts. Stop the old worker at an idle scan boundary before updating, or preserve its state and perform a reviewed rebuild separately. An idle compatible database takes a fresh anchor on its next scan and must reconcile before serving. A JSON snapshot is not silently imported as a trusted production checkpoint. The existing V1 deployment is unchanged.

State is scoped to the genesis, ordered program IDs and commitment. Checkpoint, scan-position and ownership records are authenticated/encrypted; public signatures, slots and ordering indexes are stored as SQLite metadata. An idle scan has an explicit null checkpoint, so deletion cannot masquerade as inactivity. Authenticated counts of pending transactions, program memberships, scanned signatures and ordering edges are updated atomically with spool changes and checked before admission, application, completion and readiness. Missing rows stop progress instead of silently skipping history. A missing snapshot can never be replaced by the poller's empty in-memory store.

Restrict the whole directory and its WAL files. Counts detect missing rows; they are not cryptographic authentication of every public metadata value or proof of provider completeness. The instance pin detects replacement databases, not an authentic older copy of the same database. Wrong scope/key and marked backup-restoration epochs are refused; manual rollback still requires independent history reconciliation. This does not hide on-chain transaction metadata or provide an independently verifiable history archive.

A fenced 90-second ownership lease permits one active worker. The entry point renews it every 15 seconds. Another worker is refused while it is valid; an expired worker cannot commit after takeover. Graceful shutdown releases it. After a crash, wait for lease expiry rather than deleting the database. Correct host time and local durable storage are prerequisites. Independent database copies do not coordinate ownership and are not a high-availability deployment.

The default envelope is 1,000,000 pending transactions, up to three times that many scanned program/signature memberships, 4,096 transactions in one ordered slot group and a 64 MiB serialized derived checkpoint. Each transaction is limited to 2,048 log lines, 64 KiB of log text and 256 decoded events. Capacity exhaustion refuses further work; it never discards history. The in-memory Merkle trees and derived checkpoint remain bounded by that checkpoint envelope, and checkpoint writes currently serialize derived state. Measure throughput, startup time and storage at the intended pilot size before production; this is not a claim of unlimited history or high-volume ingestion capacity. Retention, scalable incremental state storage, migration/backup/key rotation and rollback reconciliation remain release work.

## Readiness and shutdown

`/health` preserves diagnostic liveness/polling status. `/ready` returns 200 only when this worker still owns the pinned state with required checkpoint records and consistent spool counts, its last scan matched its finalized anchor without a polling error, and successful ingestion, observed head advancement and root-availability checks are less than 30 seconds old. After a reconciled scan, one contextual **confirmed** account read verifies that both indexed roots still occupy their expected positions in the accepted 128-root rings. A root overwritten by 128 later appends is unavailable. Contradictory or regressing accounts fail closed. Confirmed availability does not replace finalized ingestion.

The hosted roots, paths, leaves, bindings, census, Pocket/activity and stats routes return 503 while unready, including during a scan. They do not serve partially rebuilt state as usable proof inputs. Missing state, omitted tree history, expired roots, catch-up, stale/frozen head, lost ownership and drain all refuse admission. A root-probe outage retains an already reconciled checkpoint for the next scan; it does not discard history. `/health` exposes `rootReconciliationRequired`, `rootsUsable` and `rootsCheckedAt` for diagnosis, not a promise of future proof acceptance.

SIGTERM/SIGINT stops new webhooks and polling admission. An already admitted page or transaction finishes and checkpoints; the service waits up to 30 seconds before forced termination. The durable checkpoint remains authoritative after either exit. The process does not save an unrelated final JSON snapshot while an asynchronous poll is still running.

Finality introduces delay. High registry/census turnover can evict an indexed root from the program's accepted root ring before proof submission, even after a successful availability check. Readiness is recent evidence, not a root reservation. Test sustained root-ring availability, owner onboarding latency and required ingestion throughput under representative traffic; do not remove finality or change the ring merely to make readiness green. Confirmed-fork rollback and production archival/provider guarantees are separate release requirements.

## Reproduction

```sh
pnpm --filter @ghostlink/indexer... build
pnpm --filter @ghostlink/indexer test
# Unix signal drill, also run by Linux CI:
node services/indexer/test/drain-drill.mjs
# Requires prepared disposable validator/program/circuit artifacts:
INDEXER_FINALIZED_DRILL=1 bash scripts/localnet-e2e.sh
```

Tests cover missing/truncated logs, repeated pages, bounded multi-tick history, restart with the original anchor while the chain advances, same-slot cross-program ordering, a real child exit after checkpoint, actual SQLite rollback, ownership takeover/fencing, omitted/conflicting trees, malformed accounts, stale contexts, ring eviction, HTTP refusal and hosted webhook hints. The Unix process drill holds a transaction read, sends SIGTERM, releases the response, then checks that restart retains the cursor without replay. The local validator rejects omitted history against actual finalized accounts, reconciles roots, and exercises the complete SDK/pocket flow. Live archival acceptance, production load/soak, alerts, coordinated migration and the [mainnet release gates](MAINNET-READINESS.md) remain open.

RPC semantics: [contextual account reads](https://solana.com/docs/rpc/http/getmultipleaccounts), [signature pagination](https://solana.com/docs/rpc/http/getsignaturesforaddress) and [transaction identity and metadata](https://solana.com/docs/rpc/http/gettransaction).
