# Trusted owner consent for bots

The localnet candidate provides `ApplicationRegistry`, `OwnerConsentController` and `verifyTelegramOwnerInitData` in `@ghostlink/sdk`. These are integration primitives, not a shipped owner interface or evidence of Telegram device compatibility. The existing devnet product and its identity/recovery path remain separate.

## Trust and isolation

Only the trusted owner application handles wallet sign-in, the identity secret, witnesses and local proving. The bot owns its temporary signing key. It receives public request fields and independently checks confirmed chain state before trading. A public bot key is not a wallet key, and Telegram authentication is not authority to spend.

An operator-approved registry binds each application ID to a permanent canonical HTTPS origin, Telegram bot ID, authorization backend and exact policy. Separate bot origins produce separate app IDs and pockets for the same owner. One pocket still has one active session: another session for that same origin replaces it. The registry reserves origins and bot IDs even after disabling an application; removing or reassigning a namespace could transfer access to an existing pocket. Different strategies within one bot do not gain separate budgets from this registry.

Pin the manifest digest in trusted owner configuration. Never accept a manifest and its matching digest from a launch URL, bot response or `postMessage` as their own endorsement. `applicationRegistryDigest` canonicalizes a manifest for an operator to approve; it does not verify domain ownership, identify an honest operator or perform a security review. Review those facts before onboarding a partner. There are no commercial bot entries bundled with the SDK.

Manifests expire within seven days. `update` requires the next revision, previous digest, unchanged deployment/owner origin, and retained identity mappings. Disabled entries cannot be revived. The release/configuration system must persist the latest approved revision and enforce this continuity across restarts; constructing a new registry from an old trusted pin alone cannot detect rollback. A changed revision invalidates outstanding reviews. Disabling a registry entry prevents new approvals, but **does not revoke existing on-chain authority**.

The candidate accepts only the existing local program IDs and a pinned disposable-validator genesis hash. It explicitly refuses devnet and mainnet genesis hashes. Changing a label to `localnet` is insufficient.

## Owner flow

1. Load the pinned registry from trusted configuration. Resolve the requested application ID through it; refuse unknown/disabled/expired entries. Do not take a backend URL or origin directly from a partner message.
2. Authenticate raw Telegram Mini App `initData` using `verifyTelegramOwnerInitData(raw, application.telegramBotId)`. Its production key is pinned; a test environment is an explicit trusted configuration choice. It verifies the Ed25519 signature, bot ID, user ID and five-minute freshness window without the bot token. The algorithm follows [Telegram's third-party validation specification](https://core.telegram.org/bots/webapps#validating-data-for-third-party-use). The bot backend separately verifies its HMAC. Missing or invalid signatures must not fall back to `initDataUnsafe` or a caller-provided user ID.
3. Derive the identity locally in the owner context. Derive `appId(identity.sField, domainHash(application.appOrigin))`. Choose the recovery home and session expiry in the owner UI. For renewal, read the confirmed existing pocket and use its current policy/home and a strictly later expiry. Do not silently replace an existing session or change permissions.
4. Send only `{ requestKey, appId, home, sessionExpirySlot }` to the registered backend's `/requests`, with raw `initData` in the authorization header. Use a random idempotency key and preserve it for retries. Enforce response size/time limits, `redirect: "error"` and `cache: "no-store"`; never redirect authentication to an unregistered host. The backend returns a public pending consent.
5. Pass that response and the locally selected expectations to `controller.review`. It verifies the bot/user, deployment, derived pocket, home, exact approved policy, Ed25519 key, expiry and fresh chain context. Display the returned immutable review, including bot identity, origin, policy amounts/assets, expiry and recovery home. Require an explicit owner approval before proving.
6. Call `controller.prove` with the same review object, identity, verified witnesses and local prover. Additional holdings claims need their own clear disclosure. The controller checks all 12 proof public signals and rechecks registry, cancellation, time, genesis and chain progress before returning authorization. It releases each review at most once. It does not send private inputs anywhere or submit a transaction.
7. Use `client.pocketFor` and `client.openSession` with the returned authorization and reviewed policy/home. Keep the relayer/indexer/RPC endpoints in trusted owner configuration. After submission, ask the bot backend to confirm; it checks the actual confirmed account. A released proof, HTTP success or transaction signature alone is not activation evidence.

```ts
import { OwnerConsentController, policyFromDto } from '@ghostlink/sdk';

// registry, connection and localProver are trusted owner configuration.
const controller = new OwnerConsentController({
  registry,
  readChainContext: async minContextSlot => ({
    genesisHash: await connection.getGenesisHash(),
    slot: await connection.getSlot({ commitment: 'confirmed', minContextSlot }),
  }),
});
const review = await controller.review(botResponse, {
  applicationId, telegramUserId: authenticatedTelegram.userId,
  identity, home, expirySlot,
});
// Render review; await the owner's explicit approval in the host interface.
const authorization = await controller.prove(review, { identity, witness, prover: localProver });
const policy = policyFromDto(application.policy); // Application was resolved from the pinned registry.
const pocket = client.pocketFor(authorization, home, policy);
await client.openSession(authorization, pocket, {
  mint: new Uint8Array(32), threshold: 0n, minSlot: 0n, claim: false,
});
```

Ordinary `GhostLink` browser calls remain scoped to the actual page origin. The owner controller deliberately derives for a vetted partner origin while executing on the separate owner origin. The owner page must be top-level. Node/native callers explicitly configure `nodeOwnerOrigin`; that override is ignored in browsers. This is not a sandbox against malicious code already running in the owner page.

## Browser and recovery requirements

Serve the owner interface from an isolated origin with a restrictive CSP, `frame-ancestors 'none'`, no third-party scripts, analytics or remote prover, and reviewed wallet/prover dependencies. Keep `initData` and identity material in memory. Never put them in URLs, browser storage, logs or crash reports. A handoff must check exact sender origin, window/source, schema and a one-use nonce; return only minimal public completion information. Telegram web frames and native clients need separately tested top-level handoffs. The SDK does not yet provide or certify that handoff.

`controller.cancel(review)` prevents an in-flight local proof from being released. A failed/expired review requires a new review; an expired backend request requires a new request. Once authorization has been released, local cancellation cannot recall it. Use on-chain expiry, owner revocation/rotation and recovery for existing authority; coordinate backend cancellation as well. Registry removal and database deletion are not on-chain revocation.

Wallet identity derivation includes the trusted sign-in domain. Moving an existing owner to a new host can derive a different identity. Preserve the old recovery path and use an explicit migration; do not silently change the live devnet sign-in domain.

## Evidence and remaining gates

SDK tests verify a real committed development proof through the owner controller and reject altered permissions, cross-bot requests, forged reviews, stale/wrong chain contexts, frames, expired/cancelled reviews, registry changes during proving and substituted public signals. Telegram algorithm tests use synthetic signatures and confirm the production wrapper refuses them; these are not live Telegram acceptance tests. The local validator harness uses the controller for initial consent and restore rotation, with synthetic backend Telegram authentication and development proving keys.

The private owner interface, authenticated cross-window handoff, actual Telegram credentials/devices, production registry operations, independently reviewed ceremony and programs, fresh deployment, real provider acceptance and capped pilot remain release gates. See [mainnet readiness](MAINNET-READINESS.md).
