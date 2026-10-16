# GhostLink bot backend

Experimental Node.js backend for Telegram Mini App authentication, public-key consent requests, encrypted bot session storage and constrained intent signing. **Localnet V2 candidate only. No real-funds approval or commercial bot integration is implied.** The owner proving interface is a separate trusted application; no product interface is included here.

Use Node 22.13+ within the 22 release line, or Node 24. `node:sqlite` is experimental in these runtimes; later major versions require validation before support. The package contains no browser bundle. ESM imports and CommonJS dynamic imports are supported.

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
2. The owner verifies the vetted application/deployment, derives and compares the app ID and pocket address, and explicitly approves the public bot key, exact policy, recovery home and expiry. Only the owner context derives the identity and creates the proof. Use the SDK's public-key authorization API; never send identity secrets, witnesses or wallet keys to the bot.
3. The owner submits the V2 opening proof. `POST /requests/:id/confirm` with `{}` makes the backend independently read the confirmed on-chain account and compare its address, owner, domain, home, key, expiry and policy. A browser-supplied transaction signature is not accepted as confirmation.
4. `POST /requests/:id/status` with `{}` returns local consent state. `POST /requests/:id/cancel` with `{}` disables local signing. All routes require the same authenticated Telegram user and bot.

One idempotency key binds one immutable request. Retrying identical inputs returns the same public key and state, including after restart. Changed permissions with that key fail. Pending requests expire after five minutes by default (configurable 30–900 seconds); at most three can be pending per user. Duplicate confirmation is idempotent and rechecks chain state. Once expired/cancelled, a request cannot be reactivated: create a new request and obtain fresh owner consent.

`confirmed` describes completed consent, not perpetual spending authority. Every `manager.signIntent(id, { botId, userId }, params)` rechecks the current chain key, policy and expiry and signs only a canonical intent. This method is for an authenticated bot backend. It is **not exposed by the HTTP server**. Telegram authentication alone never authorizes a trade.

Local cancellation removes the active encrypted key record. It **does not revoke the on-chain session or invalidate an already signed intent**, and old ciphertext may remain in WAL files or backups. Use owner-authorized on-chain revocation/rotation and home recovery for that purpose. A renewed or replaced session requires new consent here; changed expiry/key is refused. Do not claim a cancelled order cannot land unless its chain deadline/revocation status establishes that.

## Storage and remaining work

Session seeds use AES-256-GCM with random nonces and the immutable consent record as authenticated associated data. SQLite transactions serialize consent changes; a key-check sentinel refuses the wrong database key. The database stores Telegram IDs, pocket/home addresses and policy metadata in plaintext. Treat the whole database, WAL and backups as sensitive. Best-effort buffer clearing is not a JavaScript process-memory isolation guarantee.

Use SQLite on local disk, not a network filesystem shared across hosts. Database/key backup and restore, encryption-key rotation, retention/purge, host compromise recovery and operational monitoring still need release evidence. Storage transactions protect consent idempotency. The reference solver now has a separate [durable transaction journal](../../docs/TRANSACTION-RECOVERY.md), but **bot-side nonce allocation and strategy jobs remain unfinished**. The caller currently supplies each intent nonce. Do not retry an unknown trade outcome as a new trade.

Tests cover forged/stale Telegram data, cross-user access, permission/key substitution, cancellation races, program/genesis mismatch, a process exit without SQLite close, encrypted-record tampering, a fresh installed consumer and a disposable-validator flow. Local end-to-end authentication uses a synthetic Telegram token; real Telegram device/wallet handoff and trusted-owner UI acceptance remain unverified. The validator uses a reference inventory route, not Jupiter. See [release gates](../../docs/MAINNET-READINESS.md) and [provider research](../../docs/BOT-COMPATIBILITY.md).

Reference specifications: [Telegram Mini App authentication](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app), [Node 22 SQLite](https://nodejs.org/download/release/v22.22.0/docs/api/sqlite.html).
