# Watcher delivery and timelock execution

The watcher reads confirmed Pocket events, forwards proposal/large-fill/execution notifications to an operator-configured receiver, and optionally pays for permissionless execution of a due change. Owner authorization and the timelock are enforced by the program. Revoking a session and cancelling a proposed change are separate owner actions. A notification is information to review, not permission to trade or change a pocket.

## Configuration

- `WATCHER_GENESIS_HASH`: independently approved chain identity; required.
- `WATCHER_STATE_PATH`: private cursor/pending snapshot path; required by the entry point.
- `RPC_ENDPOINTS_PATH` or `RPC_URL`: approved providers, as described in [RPC operations](RPC-OPERATIONS.md).
- `NOTIFY_WEBHOOK`: optional HTTPS receiver. Only local fixtures may use loopback HTTP. Without it, events are printed to the process console; that does not deliver them to an owner.
- `GHOSTLINK_WATCHER_KEYPAIR`: optional fee-payer file outside the repository. Omitting it disables execution of pending changes.
- `WATCHER_JOURNAL_PATH` and `WATCHER_JOURNAL_KEY_PATH`: required when a payer is configured. The first is a persistent SQLite path, the second a private file of 32 raw random encryption-key bytes. Keep both outside the repository, preserve the database and its WAL, and use the same database for every funded worker with this payer.
- `WATCHER_TOTAL_BUDGET_LAMPORTS`: explicit positive cumulative fee cap required for funded execution. This cap does **not** renew daily or reset on restart. Raising it requires an operator configuration change after reviewing prior spending. `WATCHER_MAX_FEE_LAMPORTS` defaults to 20000 and cannot exceed the total cap.
- `WATCHER_POLL_MS`: 100–60000 milliseconds, default 5000. `LARGE_FILL_USD_E6` defaults to 100000000 ($100).

The entry point verifies the approved chain before starting. The same bounded HTTP pool performs polling, submission and confirmation; it never switches to an unapproved WebSocket provider. Startup and polling diagnostics omit raw provider/receiver exceptions and credentials. Importing the watcher class does not start a process or deliver notifications.

## State, delivery and retries

Hosted snapshots use version 2 and bind their genesis, Pocket program and crank payer (or observer-only mode). A snapshot from a different scope or the older unscoped format is refused. Preserve the old file. Use a separate state path for a new deployment/payer and rehearse historical backfill with a local receiver before enabling live delivery or execution. Backfill requires complete provider history; do not treat a recent-only provider as evidence that old proposals do not exist. Automatic snapshot migration and coordinated payer rotation are not implemented.

Events are processed oldest-first. A transaction's cursor advances only after all its notifications succeed. Delivery failure retains the cursor and retries; restart can redeliver an already acknowledged notification if it crashed before persisting progress. Receivers must tolerate duplicates and use the public transaction signature plus event details to identify them. An HTTP success means receiver acceptance, not proof that a person saw the alert.

Webhook delivery has a 15-second deadline, refuses redirects and cancels unused response bodies. The configured URL is the delivery boundary; the caller cannot redirect it to another host. The watcher makes up to three delivery attempts with bounded backoff. Only connect a receiver approved to receive these events; test with synthetic/local receivers before contacting real users.

Before funding a crank, the watcher persists pending progress and reads the current Pocket account through its approved provider. It checks program ownership, layout, PDA, current proposal and due slot. The encrypted journal is bound to genesis, program and payer. A SQLite FULL transaction saves the exact signed packet and reserves its quoted network fee atomically before broadcast. Write failure or an excessive/unavailable fee refuses the send. Two workers sharing that journal resolve to one packet and one reservation. Separate databases do not share a budget or transaction identity.

Retries and restarts reconcile the saved signature and can rebroadcast only its original bytes. The sender checks the packet's signature, payer and complete expected instruction message, compares the RPC acknowledgment and confirms only that locally known ID. A confirmed observation stops rebroadcast until finalized resolution or proven expiry; only actual successful `ChangeExecuted`/`ChangeCanceled` events clear pending notifications. A lost response does not authorize a fresh packet or refund the reserved fee.

A replacement for the same proposal requires absent signature history, finalized height beyond the saved expiry, a finalized invalid blockhash and the same proposal still present in a finalized Pocket account. Conflicting, stale or missing evidence retains the old attempt. At most three packets are prepared for a proposal, with a new conservative reservation for each; unused reservations are not automatically refunded. A finalized execution failure stops automatic retries of that proposal and requires operator investigation. Journal `confirmed` means signature inclusion is observed, not a successful owner alert; finalized failure has its own `failed` state. Do not delete records, switch database paths or restore old copies to reset spending. Backup rollback/reconciliation and coordinated key/payer rotation remain release work.

SIGINT/SIGTERM stops admission and waits for the active tick before closing storage and transport, with a 30-second forced-stop deadline. A forced exit leaves saved packets for reconciliation. Cursor/pending JSON remains single-worker state without an exclusive process lock: run one watcher per snapshot/payer. Readiness/metrics, installed alerts, bounded backfill and production shutdown/soak acceptance remain release gates. The candidate funded V2 watcher refuses known public mainnet/devnet genesis until a verified deployment migration is implemented.

## Verification

Focused tests cover identical packets after lost/substituted acknowledgments, abrupt child exit after durable preparation, competing journal handles, atomic write failure, persistent fee caps, expiry evidence, packet instruction validation, active-work drain, scope refusal, backlog/restart, redirect refusal, streaming-response cleanup and import side effects. The service-process RPC drill starts the compiled watcher against wrong-chain/failing synthetic providers and verifies fallback, required funded configuration and private logs.

After building programs, circuits and the E2E dependency graph, run:

```sh
WATCHER_DRILL=1 bash scripts/localnet-e2e.sh
```

The disposable validator uses an explicitly synthetic mature pending account to test real compiled-program execution without waiting 24 hours, plus a future pending account that must remain untouched. This genesis state does not claim to prove owner consent. Separately, the ordinary E2E pocket uses real owner proofs to propose, revoke and cancel. The drill drops a crank acceptance reply at both the provider and watcher boundaries, checks identical fallback bytes, restarts the journal and compares the reservation with the actual payer debit. It also fails execution-notification delivery and verifies recovery without a duplicate paid attempt or false execution alert. No public-chain upgrade or live-user notification is part of this test.
