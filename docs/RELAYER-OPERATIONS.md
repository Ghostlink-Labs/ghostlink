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
- `RELAYER_JOURNAL_KEY_PATH`: file containing exactly 32 raw random bytes, managed through the operator's secret system.
- `RELAYER_DAILY_BUDGET_LAMPORTS`: conservative rolling 24-hour fee plus creation-rent ceiling, default 2 SOL. Complete message fees above 20,000 lamports are refused. Set an appropriate cap for the intended deployment.
- `RELAYER_ALLOWED_ORIGINS`, `TRUST_PROXY` and `PORT`: retain their existing meanings. Only trust forwarded addresses behind your controlled proxy.

The journal is authenticated against genesis, payer and all three program IDs. A wrong key/scope refuses access. SQLite FULL transactions atomically save packet and reservation, including all auxiliary signatures. Multiple handles to that same database coordinate preparation leases and spending. Use one hosted instance per journal/payer: independent databases do not share a budget, and admission/rate controls are process-local. This is not multi-host availability.

Legacy `RELAYER_BUDGET_PATH` configuration is refused. Before replacing an older service, stop admission and reconcile its outstanding transactions and spend window; do not erase old state or reset a funded payer's budget to make startup pass. Journal backup import, key rotation, coordinated cutover and history reconciliation need separate acceptance. Storage marked as restored is refused. Manual file rollback is not detected as a safe restore and must never be used to resume funded work.

Reservations remain charged for 24 hours after preparation even if execution fails or is uncertain. Clock correctness matters. Receipts are retained with a 10,000-operation admission limit; capacity exhaustion refuses new operations. No automatic pruning/retention migration is implemented. Health reports budget/liveness only, not chain freshness, balance or readiness. SIGTERM/SIGINT stops new admission and waits up to 30 seconds for handlers; a forced stop leaves durable operations for reconciliation.

## Verified boundary and remaining work

The focused tests cover lost/substituted replies, same-packet retries, a real child exit immediately after the durable commit, SQLite transaction rollback, concurrent handles, budget limits, wrong/stale chain evidence, conservative expiry and SDK recovery-data retention. Real compiled service processes exercise HTTP failover and opaque diagnostics. The disposable-validator recovery drill loses an accepted withdrawal reply, reopens the journal, retains the generated home destination and original signature, and verifies the actual recovered balances without a second reservation:

```sh
# Build the packages/programs/circuits as described in SETUP.md first.
RECOVERY_DESTINATION_DRILL=1 RELAYER_JOURNAL_DRILL=1 bash scripts/localnet-e2e.sh
```

These checks do not establish production readiness. Remaining work includes funded-state migration/restore/rotation, independently reconciled history, readiness and private alerts, hosted-provider load/soak, aggregate budgets and the security/deployment gates in [mainnet readiness](MAINNET-READINESS.md).
