# @ghostlink/common

This package is the protocol's dictionary. It defines, once, how every value in GhostLink is encoded and hashed — how a wallet address becomes two field-sized numbers, how an app's identity is derived, what the bytes of a spending intent look like — so that the browser SDK, the Rust programs on Solana and the zero-knowledge circuits all agree to the last byte. If two parts of the system ever disagree about a single byte, proofs stop verifying and signatures stop matching; the fixture file here is the tripwire that catches that before it ships.

## What lives here

- `field.ts` — BN254 field encoding: the hi/lo split for 32-byte keys, hash-to-field reduction.
- `poseidon.ts` — every Poseidon value in the protocol (`C`, leaves, `app_id`, `owner_tag`, session commitment, home hash, Merkle zeros).
- `merkle.ts` — the incremental append-only tree, exactly mirroring the on-chain frontier algorithm.
- `intent.ts` — the intent and policy schemas, their canonical bytes and hashes.
- `login.ts` — `loginChallengeDigest`, the domain-separated digest of a 32-byte server nonce used for off-chain authentication.
- `pda.ts` — program-derived address computation for every account.
- `registration.ts` — the registry authorization message, plus Ledger off-chain framing. Identity derivation separately signs fixed identity text twice; recovery signs that text again.
- `fixtures/vectors.json` — the shared vectors. Rust tests (`programs/verifier`) and circuit tests (`circuits/test`) load this same file.

## Regenerating vectors

```bash
pnpm vectors   # rewrites fixtures/vectors.json deterministically
pnpm test      # recomputes everything and compares
```

A vectors diff in a PR means a protocol change: call it out in the PR description.

## Login and trust boundaries

`loginChallengeDigest(nonce)` computes SHA-256 of `ghostlink:login-challenge:v1` followed by a 32-byte nonce. The backend generates, stores, expires and atomically consumes this nonce for one pending login. It must verify the session's signature over the digest and separately call `verifyLogin` with the expected session key and expiry. A public proof plus public session details alone is replayable. The SDK's `LoginProof.snarkjsProof` is the JSON proof for that verifier; `LoginProof.proof` contains the Solana byte encoding.

`domainHash` and `appId` are pure functions. They do not enforce browser isolation: any code holding the identity secret can derive every app ID. A witness validated against a supplied root only establishes internal consistency. On-chain programs enforce their root rings; off-chain applications must use a trusted root source.
