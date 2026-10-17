# GhostLink bot backend

Experimental Node.js backend for Telegram Mini App authentication, public-key consent requests, encrypted bot session storage and constrained intent signing. **Localnet V2 candidate only. No real-funds approval or commercial bot integration is implied.** The owner proving interface is a separate trusted application; no product interface is included here.

Use Node 22.16+ within the 22 release line, or Node 24. `node:sqlite` is experimental in these runtimes; later major versions require validation before support. The package contains no browser bundle. ESM imports and CommonJS dynamic imports are supported.

## Build and install

From a reviewed checkout:

```sh
pnpm install --frozen-lockfile
pnpm pack:bot
pnpm test:package:bot
```

Copy the four archives and `SHA256SUMS` from `artifacts/sdk/`. These are local archives, not a published registry release. In a pnpm consumer, resolve the companion packages explicitly:

```json
{
  "pnpm": {
    "overrides": {
      "@ghostlink/common": "file:./ghostlink-common-0.1.0.tgz",
      "@ghostlink/sdk": "file:./ghostlink-sdk-0.1.0.tgz",
      "@ghostlink/service-kit": "file:./ghostlink-service-kit-0.1.0.tgz",
      "@ghostlink/bot": "file:./ghostlink-bot-0.1.0.tgz",
      "underscore": "1.13.8",
      "@solana/web3.js>jayson": "5.0.0"
    }
  }
}
```

```sh
pnpm add ./ghostlink-common-0.1.0.tgz ./ghostlink-sdk-0.1.0.tgz ./ghostlink-service-kit-0.1.0.tgz ./ghostlink-bot-0.1.0.tgz
```

The install check uses a temporary project outside the workspace and exercises imports, declarations and encrypted storage. It does not publish packages or send a transaction.

## Operator setup

```ts
import { readFileSync } from 'node:fs';
import { BotKeyStore, BotOnboarding, createBotAuthorizationServer,
  type BotOnboardingOptions } from '@ghostlink/bot';

export function startBot(
  options: Omit<BotOnboardingOptions, 'store'>,
  trustedOwnerOrigin: string,
  databasePath: string,
  encryptionKeyPath: string,
) {
  // File holds 32 raw random bytes. Provision once outside the repository;
  // generating a new key on every restart would make existing sessions unreadable.
  const key = readFileSync(encryptionKeyPath);
  const store = new BotKeyStore(databasePath, key);
  key.fill(0);
  const manager = new BotOnboarding({ ...options, store });
  const server = createBotAuthorizationServer(manager, trustedOwnerOrigin);
  server.listen(8791, '127.0.0.1');
  return { manager, store, server };
}
```

`options` contains the operator's bot token, a confirmed Solana RPC connection, vetted application origin, exact policy, and deployment manifest (`cluster: "localnet"`, full genesis hash and Pocket/Registry/Census program IDs). These values come from trusted configuration, never the consent request. The RPC genesis is checked before creating consent and before each activation/signature. Known devnet/mainnet genesis hashes are refused. A fresh local genesis is not evidence that an unreviewed program is safe: load the reviewed binaries yourself.

Keep the bot token, database encryption key and RPC credentials in secret storage outside source control. Terminate HTTPS at an authenticated deployment boundary, redact Authorization headers and disable request-body logging. Restrict the database directory to the service account; on Windows configure its ACL explicitly. The service binds loopback in this example. Forwarded client IP headers are deliberately not trusted by the reference rate limiter; configure proxy-level limits for a real deployment. The server permits eight active operations and refuses excess work with 503; it does not retain an unbounded waiting queue. Configure RPC transport timeouts and cancellation as part of the operator connection.

## Consent protocol

The trusted owner interface sends the raw Telegram `initData` in `Authorization: tma <initData>` and its exact `Origin`. Never accept `initDataUnsafe`, a caller's user ID, or tokens in a URL. The backend validates Telegram's HMAC, duplicate fields and a five-minute authentication window. Reopen the Mini App to refresh stale Telegram data. The optional Telegram Ed25519 `signature` field remains part of the HMAC input; this is not the separate third-party Ed25519 verification scheme.

1. `POST /requests`: `{ requestKey, appId, home, sessionExpirySlot }`. `requestKey` is 16–64 random bytes encoded as lowercase hex. The owner derives `appId` locally for the operator's vetted origin. `home` is base58; field/slot values are canonical decimal strings. The backend chooses the bot key and policy. Its response contains only public consent fields and state.
2. The owner verifies the vetted application/deployment, derives and compares the app ID and pocket address, and explicitly approves the public bot key, exact policy, recovery home and expiry. Use the SDK's [pinned registry and owner controller](../../docs/OWNER-CONSENT.md) on the isolated owner origin. It also supplies Telegram third-party signature verification; the backend still independently verifies its HMAC. Never send identity secrets, witnesses or wallet keys to the bot.
3. The owner submits the V2 opening proof. `POST /requests/:id/confirm` with `{}` makes the backend independently read the confirmed on-chain account and compare its address, owner, domain, home, key, expiry and policy. A browser-supplied transaction signature is not accepted as confirmation.
4. `POST /requests/:id/status` with `{}` returns local consent state. `POST /requests/:id/cancel` with `{}` disables local signing. All routes require the same authenticated Telegram user and bot.

One idempotency key binds one immutable request. Retrying identical inputs returns the same public key and state, including after restart. Changed permissions with that key fail. Pending requests expire after five minutes by default (configurable 30–900 seconds); at most three can be pending per user. Duplicate confirmation is idempotent and rechecks chain state. Once expired/cancelled, a request cannot be reactivated: create a new request and obtain fresh owner consent.

`confirmed` describes completed consent, not perpetual spending authority. Every trade preparation rechecks the current chain key, policy and expiry. The database retains the latest confirmed account-read context for each deployment/pocket, including refused authority, across restarts and replacement consent records. Older RPC responses and concurrent stale signing results are refused. Workers must share this database to share that context; unrelated bot or solver databases do not coordinate it. These methods are for an authenticated bot backend and are **not exposed by the HTTP server**. Telegram authentication alone never authorizes a trade.

Local cancellation removes the active encrypted key record. It **does not revoke the on-chain session or invalidate an already signed intent**, and old ciphertext may remain in WAL files or backups. Use owner-authorized on-chain revocation/rotation and home recovery for that purpose. A renewed or replaced session requires new consent here; changed expiry/key is refused. Do not claim a cancelled order cannot land unless its chain deadline/revocation status establishes that.

## Durable bot orders

Use one stable request key for one business command, such as a hash of the authenticated Telegram update and action identity. Persist that mapping in your strategy system. Reuse it on every retry; a fresh random key on each attempt represents a different order.

```ts
import { sessionPublicKey } from '@ghostlink/sdk';

// consent and who come from the authenticated backend's completed consent flow.
const signed = await manager.prepareIntent(consent.id, who, {
  requestKey: durableCommandKey, // 16–64 bytes as lowercase hex
  params: { inMint, inMax, outMint, outMin, deadlineSlot }, // nonce is allocated here
});
const publicSession = sessionPublicKey(0, Buffer.from(consent.sessionKeyHex, 'hex'));
const outcome = await client.submitSignedIntent(signed, publicSession);
// Inspect outcome.state. Pending/unknown requires polling this same intent hash.
const next = await client.intentStatus(outcome.intentHashHex);
```

The database commits the nonce and exact intent before signing, then commits the verified signature before returning it. Identical requests recover the same intent/signature after a restart. Reusing a key for changed amounts, mints, deadlines or consent fails. A cancelled, failed or uncertain order never releases its nonce for reuse. All workers for a pocket must share the same local SQLite database; unrelated databases and external direct signers are not coordinated. Existing `signIntent` calls with explicit nonces now use the same counter and cannot move backwards or conflict with an allocation. Prefer `prepareIntent` for new integrations.

`manager.orderStatus(id, who, requestKey)` returns the nonce, intent hash and local `reserved`, `signed` or `cancelled` state without a bearer signature. **Signed is not submitted or confirmed.** Poll the solver's separate receipt for execution. Status lookup remains available after consent cancellation. `manager.cancelOrder(...)` prevents further local release of that order, including a signature being prepared concurrently; it cannot recall an already released signature. Unknown network outcomes require reconciliation of the original intent, never an automatic replacement trade.

The allocator uses the full unsigned 64-bit range, skips on-chain used bits and retains its counter across restarts/session changes. The Pocket accepts a sliding window of 2,048 nonces. To protect older outstanding signatures, new issuance pauses if its nonce would advance beyond any earlier order whose signed deadline has not passed. This deliberately includes cancelled and already-confirmed orders until their deadlines. Use short, realistic deadlines; backpressure is not permission to discard an uncertain trade. Strategy scheduling, execution-level cancellation and cross-host coordination are separate work.

## Storage and remaining work

Node backends can inject `createRpcPool(...).connection` as their authorization `chain` to use approved provider failover. Keep the existing durable store and request keys; an RPC timeout does not authorize a replacement trade. See [RPC operations](../../docs/RPC-OPERATIONS.md) for configuration and limitations. Production provider capacity and real-device tests remain required.

`BotKeyStore.backupTo(file)` creates an authenticated encrypted snapshot including committed WAL data. `BotKeyStore.restoreBackup(archive, newDirectory, key)` restores into a new directory and returns its database path. Opening it cancels restored active/pending consent and retires its signing keys while preserving orders and counters. Fresh keys, owner consent and solver recovery checks are mandatory before resuming. See the [recovery runbook](../../docs/BACKUP-RESTORE.md); ordinary restart and point-in-time restore have different authority rules.

Session seeds use AES-256-GCM with random nonces and the immutable consent record as authenticated associated data. Order payloads/signatures and nonce checkpoints are encrypted and bound to their identity/deployment; lookup metadata includes bot/user IDs, pocket scope, request keys, nonces and deadlines in plaintext. SQLite transactions serialize consent and order changes; a key-check sentinel refuses the wrong database key. Existing consent databases migrate without replacing their keys. Treat the whole database, WAL and backups as sensitive. Best-effort buffer clearing is not a JavaScript process-memory isolation guarantee.

`BotKeyStore.rotateKey(nextKey)` atomically re-encrypts the current database while preserving consent, signing seeds, orders and counters. Provision the new secret first, use a maintenance window and restart other workers with the new key afterward. Old backups still require their original keys. This planned storage operation does not revoke exposed signing keys; see the [rotation procedure](../../docs/BACKUP-RESTORE.md#planned-storage-key-rotation).

Use SQLite on local disk, not a network filesystem shared across hosts. Local validator backup/restore and storage-key rotation drills pass; production cutover automation, secret distribution/retirement, retention/purge, host compromise recovery and monitoring still need release evidence. Never restore an older database or delete order/counter history and resume automatically: that can lose issued signatures and permit duplicate business commands. Reconcile outstanding signatures and business history against the chain before resuming. The reference solver has a separate [durable transaction journal](../../docs/TRANSACTION-RECOVERY.md). Durable strategy jobs remain unfinished.

Tests cover forged/stale Telegram data, cross-user access, permission/key substitution, cancellation races, program/genesis mismatch, process exit without SQLite close, encrypted-record tampering, restore key retirement and a fresh installed consumer. Local validator flows use synthetic Telegram authentication; real Telegram device/wallet handoff and trusted-owner UI acceptance remain unverified. The restore drill uses inventory settlement; separate local-fork tests exercise the restricted Jupiter/Raydium CP route. See [release gates](../../docs/MAINNET-READINESS.md) and [provider research](../../docs/BOT-COMPATIBILITY.md).

Reference specifications: [Telegram Mini App authentication](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app), [Node 22 SQLite](https://nodejs.org/download/release/v22.22.0/docs/api/sqlite.html).
