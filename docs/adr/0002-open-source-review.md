# 0002 — Public development release boundaries

Date: 2026-10-16. Status: accepted for the development source release.

## Administrative authorization freshness

Owner proofs previously authorized an action payload indefinitely while their registry root remained accepted. A cancelled proposal could therefore be submitted again. Pocket now appends `owner_action_nonce: u64`; sweep, revoke, propose and cancel digests include its little-endian bytes after the existing payload. Successful administrative actions and executing a pending change increment it with overflow checks.

Clients must fetch current account state before proving. A concurrent administrative action invalidates a pending proof; refetch and prove again. A compromised live session may race owner requests by submitting authorized sweeps. Rotate that session through a fresh owner-controlled login or wait for expiry; this release does not guarantee owner-action liveness against a racing session.

The allocation changes from 2,081 to 2,089 bytes, including the Anchor discriminator. Readers reject the old allocation. This is not an in-place migration. Existing deployment operators must design and verify a migration or use a fresh deployment with updated program IDs, SDK configuration and state. Publishing this source performs no deployment.

## Authentication and privacy contract

The wallet facade exposes custom `ghostlink:signIn`, not `solana:signIn`: a pocket PDA cannot produce the standard wallet signature. Backends verify the proof, its expected domain/session, and the session signature over `loginChallengeDigest(serverNonce)`, then consume that nonce once.

The SDK is a trusted-context library. Code holding `DerivedIdentity` can derive identities for arbitrary origins. An isolated origin-enforcing broker remains future work. On-chain activity and home addresses are public; funding can link identities.

## Deployment requirements

Development proving keys are unsuitable for production. Independent circuit/program review, a suitable setup ceremony, and a coordinated account migration or fresh deployment remain necessary before using real funds. Publishing this source does not upgrade existing devnet accounts.
