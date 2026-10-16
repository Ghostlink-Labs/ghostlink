# Transaction recovery for the V2 solver

Status: localnet candidate. The bot allocates and persists an immutable signed intent; the solver records a signed transaction before broadcasting it, then reconciles that exact signature. It still uses an inventory route and a legacy message. Jupiter composition, strategy jobs, budgets, production deployment and independent review remain open release gates.

## Operator configuration

The solver requires Node 22.13+ within the 22 release line, or Node 24, and these operator-supplied values:

| Variable | Meaning |
| --- | --- |
| `GHOSTLINK_SOLVER_KEYPAIR` | Path to the solver fee-payer keypair outside source control |
| `RPC_URL` | Trusted RPC for the reviewed local validator |
| `SOLVER_GENESIS_HASH` | Independently approved full genesis hash; never infer approval just from the RPC URL |
| `SOLVER_JOURNAL_PATH` | Persistent local-disk SQLite file outside the repository |
| `SOLVER_JOURNAL_KEY_PATH` | File containing exactly 32 raw random encryption-key bytes, provisioned once and retained across restarts |
| `PRICE_ACCOUNTS` | Existing operator-selected mint-to-Pyth-account mapping |

The journal is bound to genesis, Pocket program and solver public key. A different identity or encryption key cannot reopen it. Known devnet/mainnet genesis hashes are refused for this incompatible V2 candidate. Bot consent and solver journals use separate files and namespaces. Use service-account-only file permissions (explicit ACLs on Windows), local disks, and protected backups. Never store key files beside public source or log request credentials. Signed but unbroadcast transactions are sensitive authorization material.

Records, transaction bytes, preparation leases and observations are encrypted with AES-256-GCM. Lookup columns contain the intent hash, pocket and nonce in plaintext; treat the entire database and WAL as sensitive. SQLite WAL with FULL synchronization commits before broadcast. This provides local transactional persistence, not a multi-host database or proof of a successful backup/restore drill. Restoring an old journal without reconciling outstanding transactions can lose idempotency history and is not a supported automatic recovery procedure.

## Request and status contract

`POST /intent` accepts the existing signed canonical intent. The server verifies the signature, then checks the current on-chain program/account, session key, policy, expiry, deadline and nonce before reserving a preparation claim. The same pocket/nonce cannot be rebound to another intent or session. Duplicate callers share the saved result; a crashed preparation lease can be reclaimed after 30 seconds, and the previous worker cannot commit or broadcast its stale preparation.

Before its first send, the solver stores the exact serialized signed transaction, locally derived signature, blockhash and last valid block height. The HTTP response has `intentHashHex`, `state` and, once prepared, `signature`. HTTP 202 is used for preparing, pending and unknown responses; HTTP 200 can contain a confirmed outcome, a chain failure or proven expiry. **The HTTP status alone never establishes successful settlement.** Conflicting nonce reuse returns 409. A preparation error can return 503; retain and retry the identical signed intent.

`GET /intents/:intentHashHex` reconciles a stored transaction without signing or broadcasting anything. It returns metadata only, never the raw transaction or bot secret. A retry through POST may rebroadcast the identical saved bytes after a fresh authority check; it never constructs a replacement transaction or chooses a fresh nonce. That intent's authority check cannot use a bank older than its preparation or a later recorded account read, including a refused/revoked session. Confirmed account contexts are tracked separately from processed signature-status contexts. Responses disable caching. The reference service limits eight active operations and has conservative IP/pocket request limits; production capacity, authentication and abuse budgets need an operator-specific design.

| State | Interpretation and caller action |
| --- | --- |
| `preparing` | A worker holds the preparation lease. No committed transaction identity yet; retry the same intent after a delay. |
| `pending` | A transaction is durably prepared, or the RPC has only processed it. Its inclusion is not yet confirmed. Retain the hash/signature and poll. |
| `confirmed` | RPC reports successful execution at confirmed commitment. Retain the slot and continue to finalized status where required. |
| `finalized` | RPC reports successful finalized execution. |
| `failed` | The exact signature has a confirmed/finalized on-chain error. Token changes revert atomically, but network fees can still be charged. Check `confirmationStatus` and `chainError`. |
| `expired` | History search found no signature, the blockhash is invalid after finalized expiry, and a sufficiently recent finalized Pocket account shows the nonce unused. This saved packet is never refreshed. A new strategy decision requires a new quote/intent. |
| `unknown` | RPC, context, history, journal or expiry evidence is unavailable/inconsistent. A consumed nonce without matching signature history is not proof that this particular intent succeeded. Do not create a second trade to compensate. |

Missing signature history by itself is insufficient to declare expiry. Reconciliation checks history explicitly, rejects stale contexts, distinguishes confirmed and finalized block heights, and uses the nonce bitmap only to establish non-execution after finalized expiry. An unknown or consumed nonce is retained for investigation. Restarts do not automatically clear reservations, replay all transactions or initiate new trading activity. Callers poll/resubmit the recorded intent.

RPC send/confirmation exceptions preserve the locally computed signature. A returned RPC signature that disagrees with the signed packet is reported as unknown. Confirmation waits and individual coordinator operations are bounded; operators must also configure transport-level cancellation/timeouts, RPC health/failover and end-to-end latency limits. Unknown outcomes must remain visible during outages.

## SDK usage

`client.submitIntent()` now returns an explicit `IntentSubmission` result instead of treating any returned signature as settlement. For durable callers, first use `signIntent`, persist the signed intent and its public session descriptor in protected storage, then call `client.submitSignedIntent(signed, publicSession)`. `client.intentStatus(intentHashHex)` polls without another signer interaction. A retry must reuse the same fields, nonce and signature material. The SDK snapshots mutable intent fields while signing and refuses a changed payload when resubmitting.

The bot package's `prepareIntent` allocates a nonce, reserves exact parameters and saves the signature before returning it. Reuse the same business request key after restart or timeout. Its local order status is separate from solver settlement. See the [bot contract](../packages/bot/README.md#durable-bot-orders) for window backpressure, explicit nonce compatibility and local cancellation. Durable strategy scheduling remains unfinished. On-chain revocation/deadlines govern outstanding signed intents; cancelling a local job cannot recall a packet already sent to the network.

## Verified evidence and remaining scope

Tests exercise process exits before bot signing, after bot signature persistence and after solver preparation; lost send acknowledgments, confirmation timeouts, stale RPC, wrong returned signatures, concurrent duplicate requests, lease replacement, failed persistence, changed authority, chain failures, expiry and absent history. The full disposable-validator flow allocates the bot nonce, restarts the bot/database, recovers the exact intent/signature, intentionally loses the first broadcast acknowledgment, restarts the solver/database, retries that same intent, verifies one planned transaction identity, confirms the swap and sweeps proceeds home.

These tests use synthetic Telegram authentication, development proofs and a reference inventory fill. They do not establish named-provider adoption, real Telegram device compatibility, live DEX routing or mainnet readiness. See [the release gates](MAINNET-READINESS.md).

Primary protocol references: [sendTransaction](https://solana.com/docs/rpc/http/sendtransaction), [getSignatureStatuses](https://solana.com/docs/rpc/http/getsignaturestatuses), [confirmation and expiration](https://solana.com/developers/cookbook/transactions/confirmation), [isBlockhashValid](https://solana.com/docs/rpc/http/isblockhashvalid), [getBlockHeight](https://solana.com/docs/rpc/http/getblockheight).
