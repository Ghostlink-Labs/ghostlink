# Durable relayer submissions

The V2 relayer saves each signed transaction and its fee/rent reservation in an encrypted SQLite journal **before** broadcast. Registration, census snapshots, session opening and owner actions use the same submission contract. This candidate is tested on disposable local validators and refuses known public devnet/mainnet genesis hashes; configuring storage does not approve a public deployment.

## Request and receipt contract

POST `/register`, `/snapshot`, `/open-session` or `/owner-action` with the existing request fields and a lowercase 32-byte hexadecimal `requestIdHex`. Save the complete request before sending. Reuse both ID and body on retries. The journal binds the ID to the route and canonical JSON body (including proof bytes), independent of object-key ordering. Reusing an ID with changed content returns HTTP 409.

`/snapshot` requires an explicit ID: a fresh observation needs a fresh ID, while a retry keeps its original ID. The other routes default a missing ID to the exact content digest for compatibility. Regenerating a proof or selecting a new ID creates a distinct operation and can reserve another fee. This is not semantic deduplication across new authorizations.

Responses include `requestIdHex`, `state`, and the local `signature` once prepared. Confirmed/finalized outcomes also include their on-chain `slot` and `confirmationStatus`. Sweep receipts preserve the original `tokenPairs`, including any auxiliary home accounts generated during preparation. No signed packet, proof input, payer key or provider diagnostic is returned.

| State | POST status | Meaning |
| --- | --- | --- |
| `preparing` | 202 | Another handler holds the short preparation lease; no packet is committed yet |
| `pending` | 202 | Saved packet exists; confirmation is not established |
| `unknown` | 202 | RPC/storage evidence is unavailable or blockhash validity ended without a usable receipt |
| `confirmed`, `finalized` | 200 | The same saved signature has the stated successful chain commitment |
| `failed` | 502 | The saved signature has a confirmed/finalized execution error; no automatic replacement |

GET `/submissions/:requestIdHex` reconciles the saved operation and returns its receipt; 404 means that this journal has no such ID. A failed response or missing record is not proof that a different/older service never submitted it. Validate the reviewed on-chain account and permission state independently before enabling a bot. A `confirmed` result can still be reorganized; final settlement policy is the caller's responsibility.

A retry can rebroadcast only the original signed bytes while confirmation is unresolved and the saved blockhash remains within its last valid height. Once confirmed, disappearance of a receipt does not trigger a new transaction. Expiry plus missing history remains `unknown`; this implementation does not automatically choose a fresh blockhash. Reconcile independent history and business state before authorizing a new operation. Owner-action nonces still prevent repeated effects on chain.

## Operator configuration

Use Node 22 with `node:sqlite`. Keep these paths and keys outside tracked source:

- `GHOSTLINK_RELAYER_KEYPAIR`: payer keypair JSON.
- `RELAYER_GENESIS_HASH`: independently approved chain identity; `RPC_ENDPOINTS_PATH` or `RPC_URL` supplies the approved providers.
- `RELAYER_JOURNAL_PATH`: persistent journal on local durable storage.
- `RELAYER_JOURNAL_ID`: independently pinned 64-character lowercase hex instance ID from the approved deployment record. Do not discover or replace this pin automatically during startup.
- `RELAYER_JOURNAL_KEY_PATH`: file containing exactly 32 raw random bytes, managed through the operator's secret system.
- `RELAYER_DAILY_BUDGET_LAMPORTS`: conservative rolling 24-hour fee plus creation-rent ceiling, default 2 SOL. Complete message fees above 20,000 lamports are refused. Set an appropriate cap for the intended deployment.
- `RELAYER_MIN_BALANCE_LAMPORTS`: operating reserve, default 50,000,000 lamports (0.05 SOL); must be at least the maximum 20,000-lamport network fee. This is separate from permission to spend the daily budget.
- `RELAYER_MAX_IN_FLIGHT`: total paid/reconciliation handlers, default 8, allowed range 2–64. One slot is reserved for reconciliation; overload is refused without a waiting queue.
- `OPERATIONS_PORT`: private metrics listener, default 18788, bound to `127.0.0.1`; must differ from the public HTTP port.
- `RELAYER_ALLOWED_ORIGINS`, `TRUST_PROXY` and `PORT`: retain their existing meanings. Only trust forwarded addresses behind your controlled proxy.

The journal is authenticated against genesis, payer and all three program IDs. Hosted startup uses `RelayerJournal.openExisting`: it authenticates a read-only SQLite open, rechecks the actual writable handle, requires the existing operations table, then matches the encrypted instance ID to the independent pin. Missing/empty/unauthenticated files, missing schema/identity and a different journal are refused. No spending history or identity is initialized by hosted startup. SQLite FULL transactions atomically save packet and reservation, including all auxiliary signatures. Multiple handles to that same database coordinate preparation leases and spending. Use one hosted instance per journal/payer: independent databases do not share a budget, and admission/rate controls are process-local. This is not multi-host availability.

For a **new development deployment with a fresh payer**, initialize once before funding:

```sh
# RELAYER_GENESIS_HASH must already be independently approved.
node services/relayer/dist/initialize.js /private/new-relayer
```

The destination must not exist. This command generates a fresh payer keypair, fresh storage key, empty authenticated journal and random journal instance ID. It writes private `payer.json`, `storage-key`, `journal.sqlite`, `scope.json`, then `deployment.json` last; files are flushed and directories synced on Unix. It never loads or adopts an existing payer and refuses the currently unsupported public mainnet/devnet deployment identities. It neither funds nor starts the service. Set the paths above from the approved output, pin `deployment.json`'s `journalId`, configure caps/providers, and verify startup before funding through the authorized deployment process. Keep all generated material outside source control and distribute keys through the approved secret system. If initialization fails partway, inspect the partial directory; do not delete an existing deployment to make initialization pass.

Low-level `new RelayerJournal(...)` remains available for explicitly constructed disposable fixtures; hosted services must use `openExisting` with a separately pinned identity. Legacy journals without an instance marker can still be inspected, backed up, reconciled and rotated through maintenance, but cannot enter hosted paid work. An ID pin detects a different journal, not rollback of an authentic copy with the same ID. The existing restore quarantine and independent full-history/cutover requirements still apply; do not recreate or relabel state to bypass them.

Legacy `RELAYER_BUDGET_PATH` configuration is refused. Before replacing an older service, stop admission and reconcile its outstanding transactions and spend window; do not erase old state or reset a funded payer's budget to make startup pass. The maintenance workflow below supports encrypted snapshots, quarantined restore, retained-history inspection and atomic storage-key rotation. Hosted startup still refuses restored storage. Manual file rollback is not detected as a safe restore and must never be used to resume funded work.

Reservations remain charged for 24 hours after preparation even if execution fails or is uncertain. Clock correctness matters. Receipts are retained with a 10,000-operation admission limit; capacity exhaustion refuses new operations. No automatic pruning/retention migration is implemented.

## Funding and admission

Before saving a new packet, the relayer obtains the payer's confirmed balance at least as recent as the packet context. In the same SQLite transaction that saves the packet, it requires:

```text
quoted fee + quoted creation rent + unresolved reservations + operating reserve <= payer balance
```

The existing daily spending cap is checked independently in that same transaction. Concurrent preparation handles cannot each spend the same available balance. Invalid/stale balance evidence or insufficient funds prevents packet commit and broadcast. Existing saved packets retain their original reservation and may reconcile or rebroadcast unchanged; no additional fee is reserved merely for a retry.

Liquidity reservations are conservative. A confirmed or uncertain transaction remains reserved even after 24 hours. Only a finalized receipt whose transaction slot is covered by the balance read releases its liquidity reservation; it does not refund the daily spending allowance. Already deducted but not finalized transactions may therefore be counted twice temporarily. Unknown expired packets need independent history reconciliation and never release liquidity automatically. External use of the same payer can still race a balance read; use a dedicated service payer and one journal.

## Readiness, metrics and shutdown

`GET /health` is diagnostic liveness, with a cached `spentLamports24h` (initially `null` before the first successful probe). It is not a transaction ledger read or settlement certificate. `GET /ready` returns 200 only when all cached checks pass; otherwise 503, with `Cache-Control: no-store`. Public HTTP polls trigger no RPC calls or journal scans.

Every two seconds a bounded background probe checks approved genesis, confirmed payer balance, authenticated writable storage, retained-record capacity and remaining daily budget. It scans at most the journal's 10,000 retained operations, and reconciles up to four unfinished packets in round-robin order so finalized outcomes can eventually release liquidity without client polling. These scans require hosted load acceptance; readiness does not prove provider history completeness, future disk space or affordability of the next quoted transaction.

Admission requires two advancing confirmed-context samples. Evidence expires after ten seconds; context must advance within fifteen seconds. Probes time out after seven seconds. A timed-out but still-running transport keeps its probe slot until settlement, and late success cannot restore readiness. Age/progress use monotonic elapsed time. Failed storage, wrong/stale/frozen chain, exhausted capacity/budget, insufficient reserve or drain close new admission. Actual fee, rent, balance, journal commit and permission checks remain mandatory per transaction.

The HTTP router bounds bodies, connections and active handlers; IP/wallet quotas still apply. Paid work has no waiting queue. One of the configured handler slots is reserved for existing packet retries and status reconciliation. These remain available during dependency or funding refusal while capacity permits; unavailable chain/journal evidence can still return `unknown` or an error. A 503 never authorizes changing the request ID/body or assuming that earlier work did not execute. Controls are per-process, not distributed quotas.

The loopback-only `GET /metrics` exposes readiness checks, active/accepted/rejected/completed handler counts, cached fee/rent reservations, retained-record count and bounded provider-index status. Labels contain no request IDs, signatures, payer identities, endpoint URLs, credentials or key paths. `completed` means handler completion, not successful settlement; counters reset on restart. Collect aggregate HTTP statuses at the trusted proxy and configure actual alert delivery separately.

SIGTERM/SIGINT stops new HTTP admission and periodic probes, closes the public listener, and waits for admitted handlers (including disconnected clients) and the active probe before closing the journal/RPC transport. Healthy admitted preparation can finish during drain. The private metrics listener remains available during this wait. The deadline is 30 seconds; forced exit leaves committed packets for reconciliation. An unprepared claim can be retried with the original request after its lease expires.

## Encrypted backup and quarantined recovery

After building, use `node services/relayer/dist/maintenance.js`. This local operator tool loads the **storage encryption key only**, never the payer signing key. Keep its configuration, archives and reports outside the published checkout. `RELAYER_MAINTENANCE_SCOPE_PATH` names a private JSON file with the independently approved `genesisHash`, payer public address, and `pocket`, `registry`, `census` program addresses. The same scope must authenticate the source journal and archive. `RELAYER_JOURNAL_KEY_PATH` names the raw 32-byte storage key; `RELAYER_JOURNAL_PATH` must name an existing database for all commands except restore.

```sh
# Existing environment supplies the private scope, storage-key and journal paths.
node services/relayer/dist/maintenance.js backup /private/relayer-backup.enc
node services/relayer/dist/maintenance.js restore /private/relayer-backup.enc /private/restored-relayer

# Restore creates state.sqlite in a NEW directory; it never overwrites a database.
export RELAYER_JOURNAL_PATH=/private/restored-relayer/state.sqlite
node services/relayer/dist/maintenance.js inspect /private/inventory-001.json

# Uses the same approved RPC_ENDPOINTS_PATH or RPC_URL transport as the services.
node services/relayer/dist/maintenance.js reconcile /private/history-001.json

# Atomically re-encrypt this database with an already provisioned new storage key.
node services/relayer/dist/maintenance.js rotate /private/next-storage-key
```

Backups authenticate a consistent SQLite snapshot including committed WAL pages. They are bounded to 128 MiB and never overwrite an archive. A snapshot taken while serving requests can omit later committed packets. For planned maintenance, drain and stop the hosted service before taking the cutover snapshot or rotating its key. Existing old-key handles refuse subsequent access after rotation; reopen with the new key. Rotation does not rotate the payer key or re-encrypt existing archives. Retain each archive's protected key until its retention policy permits retirement.

Every restore gets a fresh authenticated recovery epoch, including a restore of a previous restore. `RelayerJournal.openForMaintenance` permits inventory, observation, backup and rotation; it forbids claim, preparation, release and submission. Hosted server construction also refuses this handle. There is no clear-restore or paid-resumption option. Default journal construction still rejects restored data, including after every saved packet is verified and after key rotation.

`inspect` returns at most 100 authenticated records without raw signed packets. `reconcile` reads at most 100 saved packets with at most four concurrent transaction-history requests. Both accept an optional request-ID cursor as a third argument after the report filename; use `nextCursor` with a new filename to continue. Reports use exclusive creation and private file permissions. Exit zero means a report was written, **not** that all history verified or that the relayer may resume. Inspect every entry and follow pagination.

Reconciliation checks genesis and a nonregressing finalized context, validates each saved signature/message, then independently retrieves its finalized transaction. Exact signed bytes, slot bounds, recorded finality and actual fee versus the reservation must agree before a finalized observation is recorded. It does not broadcast or replace a transaction. Missing/pruned/failed-provider evidence remains `unresolved`; substitutions and contradictory finality are `conflict`. Unprepared claims remain `unprepared`. Finalized execution failures are retained as failures. Daily charges are preserved; finalized liquidity releases only under the existing covered-slot rule.

Every report states `historyCompleteness: "not-established"` and `paidResumptionAllowed: false`. An old snapshot can omit paid work even when every retained packet verifies. Recovery must still reconcile the full payer history, client request receipts, owner nonces and business effects, preserve all unresolved spending, fence the prior writer, and approve a controlled cutover. These are remaining release gates. A 404, an empty page or an all-verified snapshot never authorizes resetting the journal or spending budget.

## Verified boundary and remaining work

Hosted-process startup regressions reproduce the former missing-path reset and now verify refusal of absent, empty, wrong-instance and damaged journals; a valid restart preserves the saved packet and charge. Real initializer processes generate a new payer/storage key/instance, refuse existing destinations and unsupported public chains, and start the service with the pinned output. Legacy identity-less journals stay available for maintenance only. The hosted RPC and local-validator restart/restore drills use explicitly initialized, pinned existing state.

The focused tests cover lost/substituted replies, same-packet retries, a real child exit immediately after durable commit, SQLite transaction rollback/lock refusal, concurrent funding reservations, covered-finality liquidity release, budget limits, wrong/stale/frozen chain evidence, hung/late probes, bounded reconciliation batches, reserved status capacity, cached HTTP health, private metrics and conservative expiry. Real compiled service processes exercise HTTP failover, admission refusal and opaque diagnostics. The Unix shutdown drill disconnects a client during preparation, sends SIGTERM and verifies one confirmed packet and reservation after reopening the journal. The disposable-validator recovery drill loses an accepted withdrawal reply, reopens the journal, retains the generated home destination and original signature, and verifies actual recovered balances without a second reservation:

```sh
# Build the packages/programs/circuits as described in SETUP.md first.
RECOVERY_DESTINATION_DRILL=1 RELAYER_JOURNAL_DRILL=1 bash scripts/localnet-e2e.sh
node services/relayer/test/shutdown-drill.mjs # Linux/WSL
```

Additional file-backed tests cover old snapshots omitting later packets, quarantine through API/server entry points, wrong scope/key, repeated restore epochs, exact finalized history, missing/substituted/stale evidence, bounded pagination/concurrency, actual operator command processes and old-key fencing. The `RELAYER_RESTORE_DRILL=1` validator option runs the actual reconciliation CLI without a payer key, verifies retained paid packets against real finalized transactions, checks no payer debit, and preserves quarantine after rotation.

These checks do not establish production readiness. Remaining work includes a fully reconciled funded cutover (including operations absent from the snapshot), production secret distribution/retirement, retention/scaling, installed private alerts, hosted-provider load/soak, aggregate budgets and the security/deployment gates in [mainnet readiness](MAINNET-READINESS.md).
