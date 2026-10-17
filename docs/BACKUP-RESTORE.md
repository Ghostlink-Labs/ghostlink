# Encrypted backup and recovery

Status: localnet candidate. A disposable validator drill exercises owner rotation, settlement and sweep after restoring both databases, then rotates both storage keys while preserving orders and transaction identity. Automated multi-host cutover, production secret distribution/retirement, continuous backup orchestration and production disaster recovery remain release gates.

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
// solverJournalId is retained independently from the original deployment.
const restoredJournal = SubmissionJournal.openExisting(solverPath, solverKey, scope, solverJournalId);
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

The solver instance ID survives backup/restore and storage-key rotation. The matching pin does not clear the restore epoch or authorize an old session. Legacy snapshots without a pin require reviewed reconciliation and cutover; do not invent an ID or use the general fixture/provisioning constructor to resume a funded solver. `SubmissionJournal.openForMaintenance` supports reading known records, backup and rotation for existing compatible-schema state without transaction work.

The snippet shows APIs, not a distributed maintenance lock. Stop all source processes before cutover. Do not share SQLite files over a network filesystem. An operator holding the key can replay a valid old archive: authentication prevents tampering, not rollback. The independent log, fresh keys, on-chain rotation and business reconciliation are necessary.

## Planned storage-key rotation

`BotKeyStore.rotateKey(nextKey)` and `SubmissionJournal.rotateKey(nextKey)` re-encrypt the existing database in one SQLite write transaction. They preserve consent, bot signing seeds, order IDs, nonce reservations, exact transaction bytes, authority floors and restore/quarantine state. This operation does not restore an earlier snapshot or require new owner consent. Supply a different, independently generated 32-byte key for each store.

Each encrypted record is authenticated under its original associated data before re-encryption. Unknown tables, columns, metadata, views or triggers are refused, so future schema changes need a reviewed migration. An authentication failure rolls back the entire change. The storage key check is committed with the records. Bot/solver workers using these APIs verify that check inside their write transactions; workers holding the old key must reopen and cannot commit old-key records afterward. A signature computed by a stale worker is not released if its final persistence step fails. A racing backup is refused if its snapshot and encryption key disagree.

Use a planned maintenance window:

1. Provision fresh random key bytes into a protected, versioned secret entry **before** rotation. Confirm that operators can recover both current and replacement versions. Keep keys out of command arguments, logs and source control. Do not overwrite the only copy of the current key.
2. Stop ingress, schedulers and all workers, drain in-flight work, then take verified backups. Open the exact existing database path with its current key. Confirm its deployment identity and known order/transaction records; a mistyped new path must not become an empty replacement database.
3. Call `rotateKey` using the replacement secret. This blocks database writes for the full migration and reads each table into memory; measure duration and memory on representative production data before scheduling a cutover. Do not run schema upgrades concurrently.
4. Close the maintenance handle, update the service's key-version reference and reopen with the replacement key. Check known consent/orders or transaction identities and recovery state, then take and restore-test a new backup. Restart workers with the new version. Rotation of bot and solver databases is individually atomic, not a cross-database transaction: record each one's actual key version separately.
5. If the process dies or the result is ambiguous, stop all workers and determine which approved key opens the **same** database. A tested mid-transaction process exit recovers the complete old-key state; a committed rotation requires the new key. Preserve the original storage error. Do not initialize a new database, discard reservations or restore an older snapshot merely to resolve a key-version mismatch.

Example maintenance calls after the replacement secrets have been durably provisioned:

```ts
const nextBotKey = readFileSync(nextBotKeyPath);
const nextSolverKey = readFileSync(nextSolverKeyPath);
try {
  botStore.rotateKey(nextBotKey);
  journal.rotateKey(nextSolverKey);
} finally {
  nextBotKey.fill(0);
  nextSolverKey.fill(0);
}
// Close stores; verify reopening with the new versions before restarting services.
```

Older archives remain encrypted by their original key. Retain those key versions separately according to the backup retention policy; changing the current key does not re-encrypt archived copies. Old ciphertext can also remain in database free pages, WAL files, filesystem snapshots or storage-device history. This API makes no forensic-erasure guarantee. Follow the storage retention/sanitization procedure before retiring a key. SQLite documents [transaction rollback behavior](https://www.sqlite.org/lang_transaction.html) and [deleted-content retention](https://www.sqlite.org/pragma.html#pragma_secure_delete).

Storage-key rotation deliberately preserves bot signing keys. If a storage key or bot seed was exposed, use owner-authorized on-chain revocation and fresh session keys as part of incident recovery; re-encryption alone cannot remove an attacker's signing capability. Production secret-manager distribution, old-key access policy, capacity rehearsal and incident response still require deployment-specific acceptance.

## Reproduction

After building the workspace, development circuit artifacts and reviewed program binaries, run on Linux/WSL:

```sh
RESTORE_DRILL=1 KEY_ROTATION_DRILL=1 CARGO_TARGET_DIR=/path/to/reviewed/program-build bash scripts/localnet-e2e.sh
```

The drill uses synthetic Telegram authentication and inventory prices on a disposable validator. It snapshots both stores, releases a signature after the snapshot, restores into new paths, rejects the old signer, pins fresh consent, submits a real owner login proof and waits for finalized rotation. It then re-encrypts the bot after order signing and the solver after losing a broadcast acknowledgment, reopens both with their new keys, recovers the same signed order and transaction, confirms the versioned fill and sweeps the entire output balance home.

File-backed tests cover WAL inclusion, snapshot isolation, corruption, wrong key/scope, overwrite refusal, repeated restore epochs, retained nonce reservations, exact pending-transaction reconciliation, delayed old rotations and separate finalized/confirmed freshness. Rotation tests include process exit midway through re-encryption, automatic SQLite rollback, unknown schema refusal, stale workers, an in-flight signer, restore metadata and a racing backup. The isolated packed bot consumer exercises backup/restore and key rotation. No production credential, public-chain transaction or live-provider adoption is implied.

Node's [SQLite backup API](https://nodejs.org/docs/latest-v22.x/api/sqlite.html) requires Node 22.16 or later in that release line; Node 24 is also supported. See [transaction outcomes](TRANSACTION-RECOVERY.md) and [remaining release gates](MAINNET-READINESS.md).
