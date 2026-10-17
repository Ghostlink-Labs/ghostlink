# Watcher delivery and timelock execution

The watcher reads confirmed Pocket events, forwards proposal/large-fill/execution notifications to an operator-configured receiver, and optionally pays for permissionless execution of a due change. Owner authorization and the timelock are enforced by the program. Revoking a session and cancelling a proposed change are separate owner actions. A notification is information to review, not permission to trade or change a pocket.

## Configuration

- `WATCHER_GENESIS_HASH`: independently approved chain identity; required.
- `WATCHER_STATE_PATH`: private cursor/pending snapshot path; required by the entry point.
- `RPC_ENDPOINTS_PATH` or `RPC_URL`: approved providers, as described in [RPC operations](RPC-OPERATIONS.md).
- `NOTIFY_WEBHOOK`: optional HTTPS receiver. Only local fixtures may use loopback HTTP. Without it, events are printed to the process console; that does not deliver them to an owner.
- `GHOSTLINK_WATCHER_KEYPAIR`: optional fee-payer file outside the repository. Omitting it disables execution of pending changes.
- `WATCHER_POLL_MS`: 100–60000 milliseconds, default 5000. `LARGE_FILL_USD_E6` defaults to 100000000 ($100).

The entry point verifies the approved chain before starting. The same bounded HTTP pool performs polling, submission and confirmation; it never switches to an unapproved WebSocket provider. Startup and polling diagnostics omit raw provider/receiver exceptions and credentials. Importing the watcher class does not start a process or deliver notifications.

## State, delivery and retries

Hosted snapshots use version 2 and bind their genesis, Pocket program and crank payer (or observer-only mode). A snapshot from a different scope or the older unscoped format is refused. Preserve the old file. Use a separate state path for a new deployment/payer and rehearse historical backfill with a local receiver before enabling live delivery or execution. Backfill requires complete provider history; do not treat a recent-only provider as evidence that old proposals do not exist. Automatic snapshot migration and coordinated payer rotation are not implemented.

Events are processed oldest-first. A transaction's cursor advances only after all its notifications succeed. Delivery failure retains the cursor and retries; restart can redeliver an already acknowledged notification if it crashed before persisting progress. Receivers must tolerate duplicates and use the public transaction signature plus event details to identify them. An HTTP success means receiver acceptance, not proof that a person saw the alert.

Webhook delivery has a 15-second deadline, refuses redirects and cancels unused response bodies. The configured URL is the delivery boundary; the caller cannot redirect it to another host. The watcher makes up to three delivery attempts with bounded backoff. Only connect a receiver approved to receive these events; test with synthetic/local receivers before contacting real users.

Before funding a crank, the watcher persists pending progress. If storage cannot be written, it stops before sending. It derives the transaction ID from the signed packet, compares the RPC acknowledgment and confirms only that locally known ID. Wrong acknowledgments, provider failures and on-chain errors keep the pending change. A successful confirmation clears it; the execution notification still comes from the actual successful `ChangeExecuted` event in a later poll. The program refuses execution before the current timelock and refuses cancelled changes.

RPC failover resends identical bytes within one submission. The watcher does not yet have an exact-packet journal across process restart, aggregate fee budgets, an exclusive multi-process state lock, or production readiness/drain/alert supervision. Run one worker per state/payer; keep these as release gates before funded mainnet operation. Never infer transaction failure or authorize a new owner action solely from a lost acknowledgment.

## Verification

Focused tests cover substituted acknowledgments, provider diagnostic privacy, retained pending state, storage refusal before funding, cross-chain/payer snapshot refusal, backlog/restart/failed execution, redirect refusal, streaming-response cleanup and import side effects. The service-process RPC drill starts the compiled watcher against wrong-chain/failing synthetic providers and verifies fallback plus private logs.

After building programs, circuits and the E2E dependency graph, run:

```sh
WATCHER_DRILL=1 bash scripts/localnet-e2e.sh
```

The disposable validator uses an explicitly synthetic mature pending account to test real compiled-program execution without waiting 24 hours, plus a future pending account that must remain untouched. This genesis state does not claim to prove owner consent. Separately, the ordinary E2E pocket uses real owner proofs to propose, revoke and cancel. The drill drops a crank acceptance reply, checks identical fallback bytes and actual on-chain state, fails execution-notification delivery, restarts the watcher and verifies retry without a false execution alert. No public-chain upgrade or live-user notification is part of this test.
