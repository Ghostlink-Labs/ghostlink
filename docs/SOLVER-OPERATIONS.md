# Solver readiness, overload and shutdown

The candidate solver distinguishes process liveness from permission to accept new work. These are operating checks, not a mainnet release attestation. Program deployment, owner authorization, route validation, prices, simulation and durable transaction persistence still apply to each trade.

## Initialization and existing state

Hosted startup uses `SubmissionJournal.openExisting` and requires `SOLVER_JOURNAL_ID` alongside the journal path, storage key and independently approved genesis. The encrypted random instance ID is distinct from the encryption key and is pinned in operator configuration. Even another valid journal with the same scope/key/payer is refused when its ID differs. A missing or empty database, missing identity marker or missing history/context/recovery table is not initialized or repaired during startup. Readiness and transaction mutations also refuse a changed/deleted identity marker.

For a new disposable development deployment, build the solver and run from the repository root:

```sh
SOLVER_GENESIS_HASH='<independently-approved-local-genesis>' \
  node services/solver/dist/initialize.js /private/new-solver
```

The command exclusively creates a new directory with a fresh solver keypair, 32-byte storage key and authenticated journal. It never reads an existing configured solver keypair, funds the new payer or starts the service. It writes `payer.json`, `storage-key`, `journal.sqlite`, `scope.json` and finally `deployment.json`. Preserve a partial directory for inspection after failure; rerunning against an existing directory is refused. Files are private on Unix; configure explicit service-account-only ACLs on Windows.

Retain the deployment manifest separately in protected operator configuration. Set `GHOSTLINK_SOLVER_KEYPAIR`, `SOLVER_JOURNAL_KEY_PATH`, `SOLVER_JOURNAL_PATH` to its files, `SOLVER_JOURNAL_ID` to its `journalId`, and `SOLVER_GENESIS_HASH` to its approved scope. Verify those values before funding the fresh payer. Do not rediscover the expected ID from whichever database happens to occupy the configured path on every restart. Keep all generated files and credentials outside source control.

Legacy compatible-schema journals without an instance marker can be read/backed up/rotated through `openForMaintenance`; they cannot claim, prepare or update transactions. Older incompatible schemas need a reviewed migration. The general constructor remains for explicit provisioning and disposable fixtures, not hosted recovery. A legacy funded payer must not be paired with a newly created empty journal. Reconcile its full business/chain history and perform a controlled cutover before resuming jobs.

The pin detects missing/substituted state, not authentic rollback of the same journal. Supported backup restores retain the ID and add quarantine; trade authority still requires the existing per-pocket finalized owner-session recovery. Complete history reconciliation, aggregate budgets and coordinated cutover remain release gates. See [backup and restore](BACKUP-RESTORE.md).

## Endpoints and admission

- Public `GET /health`: process liveness only. A provider outage does not require repeatedly restarting a healthy process.
- Public `GET /ready`: cached readiness; HTTP 200 when all checks pass, otherwise 503. Responses use `Cache-Control: no-store`. Configure a load balancer's readiness check here. A successful response does not reserve capacity for a subsequent request.
- Private `GET /metrics`: the entry point binds this separate server to `127.0.0.1:18789`. `OPERATIONS_PORT` can change the port; it must differ from `PORT` (default 8789). The host/network namespace must be trusted. Do not expose this listener through the public reverse proxy.

New `POST /intent` work is refused with 503 until readiness passes. A refusal never authorizes changing the nonce, business request key or signed intent. Retry the identical intent with bounded backoff. Known-intent status reads remain available during dependency failure or draining while capacity permits; a failure to obtain chain evidence can still return `unknown`. A missing or inaccessible journal is not proof that a trade never happened.

The first ready state requires two successful samples that show an advancing confirmed bank. The background probe runs every two seconds, with at most one probe in flight. It verifies the configured genesis and the solver's confirmed account balance/context, and commits a fresh encryption of the journal's existing key-check sentinel under `synchronous=FULL`. This changes no trade, nonce, session, restore epoch or signing key. A contended journal probe fails immediately instead of waiting for SQLite's ordinary five-second busy timeout; that timeout is restored afterward. Read-only storage, a stale encryption-key holder or an authentication failure stop admission.

`SOLVER_MIN_BALANCE_LAMPORTS` defaults to 5,000,000 lamports (0.005 SOL) and must cover at least the configured maximum network fee. Set the operational reserve for the intended workload and account-creation costs. This reserve is not an aggregate spending cap or a guarantee that every route is affordable. Production fee/inventory budgets remain a separate gate.

Evidence expires after ten seconds. Confirmed context must have advanced within fifteen seconds; a chain stall closes admission even when the provider answers promptly. Probes time out after seven seconds. A hung injected transport cannot create an accumulating queue of probes, and late results after a timeout cannot restore readiness. The normal entry point uses the [bounded RPC pool](RPC-OPERATIONS.md). Wall-clock changes do not extend readiness because its age/progress calculations use monotonic elapsed time.

Successful probes only establish these narrow dependency checks. They do not scan every encrypted record, guarantee future disk space, check every price/route/provider API, or replace transaction-time permission and persistence checks. Restore quarantine remains enforced per pocket even if global readiness is true.

## Overload bounds

The shared HTTP router accepts at most 64 requests being read or handled and 512 connections by default. Its existing 64 KiB body limit and header/body timeouts still apply. Request overload returns 503 with `Retry-After: 1` and closes that connection; exceeding the connection limit can drop a connection before an HTTP response. A client disconnect does not free an active handler's slot until its work actually settles.

The solver additionally allows eight intent/status operations in total and retains its per-IP/per-pocket request quotas. The shared rate limiter retains at most 10,000 identities per instance and refuses oversized keys. At capacity it refuses new identities instead of evicting live quotas. Expired entries are reclaimed in insertion order. The shared generic semaphore retains at most 64 waiting jobs by default. The relayer instead rejects overload immediately and reserves a slot for existing-operation reconciliation; see [relayer operations](RELAYER-OPERATIONS.md). These are per-process memory/admission bounds, not a distributed rate limit or a throughput SLA. A malicious client can still consume available capacity; configure the trusted front proxy and keep `TRUST_PROXY` disabled unless it overwrites forwarded addresses.

## Monitoring and shutdown

The private listener emits [Prometheus text exposition](https://prometheus.io/docs/instrumenting/exposition_formats/). Scrape it from the same host/network namespace or through a private tunnel. Metrics have fixed labels: readiness checks, operation kind/outcome and at most four provider indices. They contain no user IDs, intent hashes, signatures, endpoint URLs, credentials or key-file paths. `completed` counts settled handler work, not successful trades. These operation counters exclude earlier router/body/quota refusals; collect overall HTTP status counts at the trusted front proxy as well. Counters restart with the process; provider consecutive-failure gauges reset on a successful request. An endpoint marked available is not continuously probed in the background; actual RPC readiness evidence comes from the solver checks.

Suggested starting alerts to rehearse before release:

| Evidence | Operator response |
| --- | --- |
| Scrape `up` is zero for 30 seconds | Inspect host/process reachability and restart policy; retain journal files |
| `ghostlink_solver_ready` is zero for 30 seconds | Inspect the fixed `ghostlink_solver_check` flags, capacity and provider gauges |
| `storage` check fails | Pause new work; inspect storage permissions, lock contention, disk and approved key version; never replace the journal with an empty one |
| `feeReserve` check fails | Review spending and reconcile the approved solver funding reserve |
| `chainProgress` or `fresh` fails | Inspect trusted provider/network progress; do not lower authorization context floors |
| `ghostlink_rpc_quarantined` is one | Investigate a genesis mismatch before restarting with approved configuration |
| Sustained capacity/rejection pressure | Measure workload and upstream quotas; do not blindly increase concurrency or allow unlimited retries |

Actual scrape installation, alert delivery, production thresholds and operator acknowledgment still require deployment evidence. The repository does not send notifications to an external channel.

On `SIGTERM` or `SIGINT`, the entry point closes new admission and stops accepting HTTP connections. It waits for active work, including handlers whose clients disconnected, before closing the RPC pool and encrypted journal. Node's [HTTP server close callback](https://nodejs.org/api/http.html#serverclosecallback) alone is not evidence that application work finished. After 30 seconds the process closes connections and exits with status 1. Exact prepared packets remain in the durable journal for reconciliation; forced termination does not mark them failed or permit replacement transactions. Graceful signals must reach the Node process; production supervisor/container behavior must be rehearsed. The Unix signal test is not a Windows service-manager certification.

## Evidence and remaining release work

Focused tests cover slow request bodies, disconnected handlers, rate-limit cardinality, waiting-queue refusal, stalled/late probes, chain progress, fee reserve, authenticated journal write failures, SQLite lock contention, drain behavior, cached readiness and bounded private metrics. Actual initializer/startup processes verify refusal of missing/empty/substituted/legacy/incomplete-schema state and preserve packet identity, nonce ownership and authority floors across a valid restart. Backup/key rotation retain the pin and owner-recovery quarantine. A Unix child-process drill starts the real solver entry point, interrupts a request during an RPC read, disconnects its client, sends `SIGTERM`, verifies that work drains before exit, and reopens the pinned encrypted journal.

Run `RPC_FAILOVER_DRILL=1 OPERATIONS_DRILL=1 bash scripts/localnet-e2e.sh` after building the programs, development circuits and E2E dependencies. The disposable validator drill takes both RPC proxies offline, observes readiness/admission refusal with liveness preserved, restores the providers, and completes owner consent, pocket creation, lost-acknowledgment recovery, settlement and owner withdrawal. It uses local development keys and synthetic Telegram authentication.

Measured hosted-provider throughput, representative concurrent trading workloads, sustained soak/abuse testing, disk exhaustion/host failure, actual supervision/alert delivery, aggregate budgets and the other services' readiness remain required. These tests do not establish named-bot adoption or production/mainnet readiness. See [release gates](MAINNET-READINESS.md).
