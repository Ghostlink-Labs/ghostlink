# GhostLink SDK

Experimental TypeScript/JavaScript SDK for Solana identity proofs and policy-controlled pockets. Node.js bot backends and browser applications can use the same intent format. **Development networks only.** This is not an integration with any named trading bot, and installing it does not grant a bot permission to trade.

## Install from reviewed source

Use Node 22 and pnpm 10.33.2. From a reviewed checkout of `Ghostlink-Labs/ghostlink`:

```sh
pnpm install --frozen-lockfile
pnpm pack:sdk
pnpm test:package
```

The archives and SHA-256 checksums are written to `artifacts/sdk/`. Copy both archives to your bot project. No npm registry release is implied by the package name. Do not install an unrelated package with a similar name.

For npm, install both local archives together:

```sh
npm install ./ghostlink-common-0.1.0.tgz ./ghostlink-sdk-0.1.0.tgz
```

For pnpm, set the unpublished dependency's local resolution in the bot project's `package.json`, then install both archives:

```json
{
  "pnpm": {
    "overrides": { "@ghostlink/common": "file:./ghostlink-common-0.1.0.tgz" }
  }
}
```

```sh
pnpm add ./ghostlink-common-0.1.0.tgz ./ghostlink-sdk-0.1.0.tgz
```

ES modules use `import`. CommonJS applications can use `await import('@ghostlink/sdk')` inside an async function. TypeScript declarations are included. The package check installs into a separate temporary project, checks imports/types, and verifies a real intent signature; it does not send a transaction.

## Authorize a bot without sharing the owner's secret

The bot creates a temporary session key. Only its public key crosses to the user's trusted authorization interface:

```ts
import { softwareSession, sessionPublicKey } from '@ghostlink/sdk';

const botSigner = softwareSession();
const publicSession = sessionPublicKey(0, botSigner.key32);
// Serialize only the public key, not botSigner or an owner identity.
const publicKeyBytes = Array.from(publicSession.key32);
```

On the user's trusted device, after authenticating the handoff and showing the bot, pocket policy, home and expiry:

```ts
import { sessionPublicKey } from '@ghostlink/sdk';

const authorization = await client.authorizeSession({
  identity, witness, home, expirySlot,
  session: sessionPublicKey(0, Uint8Array.from(publicKeyBytes)),
});
const pocket = client.pocketFor(authorization, home, approvedPolicy);
await client.openSession(authorization, pocket, {
  mint: new Uint8Array(32), threshold: 0n, minSlot: 0n, claim: false,
});
```

Here `client` is an initialized GhostLink client with a local prover and trusted service endpoints. `identity` and `witness` stay on the user's trusted device. They must not be requested by a bot backend. This API supplies the proof/key boundary; it does **not** supply the hosted handoff, consent UI, Telegram authentication, or isolated origin-enforcing identity broker.

After confirmed activation, the bot reads the pocket from the correct chain, checks its owner/layout, session key/expiry and policy, reserves a nonce in a durable per-pocket store, and signs an exact swap intent with `signIntent` or `client.submitIntent`. A client-supplied callback or a Telegram message is not evidence of on-chain authorization. On an uncertain submission result, reconcile the same intent and transaction before allocating a replacement nonce.

An authorization contains no signing function. `authorizeSession` accepts only Ed25519 bot keys: a remote P-256 public key is not evidence of a hardware passkey. The existing `client.prove` method still supports locally held software/passkey signers for interactive apps. Existing pockets retain their original policy: passing a new policy to `pocketFor` does not update on-chain permissions.

## Current limits

- The facade refuses `mainnet-beta` because verified production IDs and ceremony keys are not shipped. This is a configuration guard, not an RPC genesis check or a sandbox around low-level functions.
- Only classic SPL Token swaps are supported. Token-2022 transfers and native SOL swap legs need explicit implementations.
- Input tokens require a pinned fresh price feed. Software sessions cannot buy unpriced output tokens. Unattended new-token sniping is not supported.
- One active session key exists per pocket. A new session replaces the previous one. One bot cannot independently revoke another key in the same pocket because multiple concurrent delegations are not implemented.
- The initial policy hash is not bound into the current login proof. Verify the confirmed policy on the owner's device before funding development pockets; production requires a circuit/program change that binds the approved policy.
- Passkey sessions require user interaction. Backend automation uses Ed25519 sessions under the existing limits.
- Nonce persistence, quote construction, DEX routing, transaction landing and confirmation reconciliation are integrator/service responsibilities.
- The SDK does not expose arbitrary wallet transaction signing or unrestricted withdrawals. A pocket is a program account, not an ordinary keypair wallet.

See the repository's `docs/INTEGRATIONS.md` and `docs/MAINNET-READINESS.md` for the supported boundaries and release gates.
