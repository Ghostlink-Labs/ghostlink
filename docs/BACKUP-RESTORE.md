# Encrypted backup and recovery

Status: localnet candidate. A disposable validator drill exercises actual owner rotation, settlement and sweep after restoring both databases. Automated multi-host cutover, continuous backup orchestration, storage-key rotation and production disaster recovery remain release gates.

## Archive and restore contract

`BotKeyStore.backupTo(file)` and `SubmissionJournal.backupTo(file)` use SQLite's backup API, including committed WAL pages. Copying a live `.sqlite` file alone is unsupported. Each archive encrypts and authenticates the complete SQLite snapshot with AES-256-GCM and a purpose-specific namespace. Solver archives also bind genesis, Pocket program and solver identity. Retain the original 32-byte storage key in separate protected secret storage.

Archives are limited to 128 MiB of database data and authenticated in memory before SQLite opens them. Allow several times that amount of free memory, plus private local snapshot space. Archives are created exclusively, flushed and never overwrite existing files. A failed operation may leave an incomplete archive: authentication will fail; retry with a new filename. Temporary snapshots contain sensitive metadata and encrypted records. Use encrypted local disks and service-account-only directories; a crash can leave temporary files requiring inspection. Configure explicit directory ACLs on Windows.

`restoreBackup` requires a new destination directory and returns its `state.sqlite` path. Wrong keys, altered/truncated archives and namespace substitution fail before database creation. Restore checks SQLite integrity and records a new authenticated recovery epoch before returning. Existing destination directories are refused. Failure can leave the newly created directory for inspection; do not treat it as a successful cutover.

## History is separate from permission

A snapshot can predate an issued signature or a sent transaction. That signature may remain valid even when its nonce is unused on chain. Selecting the first unused nonce or restarting an old signing key is unsafe.

On opening a restored bot database, previously pending/confirmed consents become cancelled and their signing keys become inaccessible through the store. Orders, reservations and counters remain. New consent generates a fresh random key and requires owner installation on chain. Subsequent ordinary restarts preserve the new consent; another restore retires it again. This is logical retirement, not forensic erasure of historical SQLite pages or other copies.

Every restored solver pocket is quarantined, including pockets absent from the backup. A trusted operator pins the public key from newly created consent **before** owner installation. This captures the current confirmed session and its maximum expiry. Trading requires a finalized account containing that exact replacement key, a strictly greater maximum expiry and a later slot. Normal policy, expiry, deadline and nonce checks still apply. Confirmed and finalized freshness floors are separate. A different key from a delayed old session-change transaction is insufficient.

The pinning API is administrative. Never expose it through an unauthenticated HTTP route or choose its key from a submitted trade. Obtain the key directly from newly created trusted consent; do not import an old seed. Later session replacements must be pinned again before installation. There is no flag that permanently disables recovery checks. Trusted RPC and deployment configuration remain prerequisites.

## Operator sequence

1. Disable ingress and stop every old producer, scheduler and solver worker, including other hosts. Record deployment identity, archive hashes, cutover time and unresolved business requests in an independent durable operations log. The library cannot prove remote workers have stopped.
2. For a coordinated backup, open the quiescent stores, call `backupTo` on each, then close them. A live backup is individually consistent; two live backups are **not** a globally consistent pair. Store archives and keys separately and retain unresolved request/transaction identities in protected operations records.
3. Restore both archives into new private directories using the original keys and scope. Point recovery-only processes at the returned paths. Keep original databases for investigation. Do not reset counters or discard unknown outcomes to resume trading.
4. Reconcile known solver signatures with `status`/`GET /intents/:hash`; these reads do not broadcast. Post-snapshot transactions may be absent entirely: reconcile the independent business log and chain history before enabling jobs. A consumed nonce alone cannot identify which request executed.
5. Create new bot consent with a new request key and a later session expiry. Pin its public key with `SubmissionCoordinator.prepareRecovery`, then have the owner authorize it with a new proof. Poll until rotation is finalized, confirm bot consent and verify the old key is refused. Repeat per pocket. Even a newly created pocket in a restored journal requires explicit recovery setup and rotation.
6. Enable a capped smoke trade, check its exact outcome and balances, and rehearse owner revocation/sweep. Resume reconciled jobs only afterward. Never create a compensating trade solely because history is missing.

Core calls, with paths, keys, scope and connection from trusted operator configuration:

```ts
import { BotKeyStore } from '@ghostlink/bot';
import { SubmissionJournal } from '@ghostlink/solver/journal';
import { SubmissionCoordinator } from '@ghostlink/solver/submission';

await botStore.backupTo(botArchive);
await journal.backupTo(solverArchive);
const botPath = BotKeyStore.restoreBackup(botArchive, newBotDirectory, botKey);
const solverPath = SubmissionJournal.restoreBackup(solverArchive, newSolverDirectory, solverKey, scope);
const restoredBot = new BotKeyStore(botPath, botKey);
const restoredJournal = new SubmissionJournal(solverPath, solverKey, scope);
const recovery = new SubmissionCoordinator(connection, restoredJournal);

// freshConsent comes from BotOnboarding using restoredBot.
// Pin BEFORE the owner installs this newly generated key.
await recovery.prepareRecovery(freshConsent.pocket, {
  sessionKind: 0,
  sessionKeyHex: freshConsent.sessionKeyHex + '00', // 33-byte Pocket account encoding
});
// Owner installs the key with a later expiry; poll without passing another key.
const state = await recovery.prepareRecovery(freshConsent.pocket);
if (state.rotationRequired) throw new Error('Owner rotation is not finalized yet');
// Confirm consent through BotOnboarding before permitting signing.
```

The snippet shows APIs, not a distributed maintenance lock. Stop all source processes before cutover. Do not share SQLite files over a network filesystem. An operator holding the key can replay a valid old archive: authentication prevents tampering, not rollback. The independent log, fresh keys, on-chain rotation and business reconciliation are necessary. Changing the storage-key file is not re-encryption; tested storage-key migration remains unfinished.

## Reproduction

After building the workspace, development circuit artifacts and reviewed program binaries, run on Linux/WSL:

```sh
RESTORE_DRILL=1 CARGO_TARGET_DIR=/path/to/reviewed/program-build bash scripts/localnet-e2e.sh
```

The drill uses synthetic Telegram authentication and inventory prices on a disposable validator. It snapshots both stores, releases a signature after the snapshot, restores into new paths, rejects the old signer, pins fresh consent, submits a real owner login proof, waits for finalized rotation, rejects the old signature again, then completes a versioned fill through lost acknowledgment/restart and sweeps the entire output balance home.

File-backed tests cover WAL inclusion, snapshot isolation, corruption, wrong key/scope, overwrite refusal, repeated restore epochs, retained nonce reservations, exact pending-transaction reconciliation, delayed old rotations and separate finalized/confirmed freshness. The isolated packed bot consumer exercises the backup/restore API. No production credential, public-chain transaction or live-provider adoption is implied.

Node's [SQLite backup API](https://nodejs.org/docs/latest-v22.x/api/sqlite.html) requires Node 22.16 or later in that release line; Node 24 is also supported. See [transaction outcomes](TRANSACTION-RECOVERY.md) and [remaining release gates](MAINNET-READINESS.md).
