# ADR 0003: Bind pocket session consent to policy and deployment

Status: locally verified candidate, pending independent review. Not deployed.

## Problem

V1 login proofs bind a home address, domain, app identity and session key/expiry. The initial policy is a separate instruction argument. A submitter holding a valid first-opening proof can replace that policy before the pocket exists. A login-only proof also lacks an explicit purpose boundary separating site access from pocket authority.

## Decision

Append `authorization_context` as public signal 11 (zero-based), bringing the login statement to 12 signals. A website login uses zero. A pocket authorization uses:

```text
SHA256(
  UTF8("ghostlink:open-session:v2") ||
  pocket_program_id[32] || registry_program_id[32] || census_program_id[32] ||
  SHA256(canonical_policy_bytes)[32] || session_kind[u8]
) interpreted big-endian and reduced modulo the BN254 scalar prime
```

Every component after the fixed tag has fixed length. Canonical policy encoding is unchanged. The other public signals continue binding the home, session key/expiry, app/domain and optional holdings claim. Circom exposes the context as a public input; the program recomputes it from authoritative values instead of trusting a caller-supplied hash. Tests must establish that changing any public input invalidates the proof with the actual generated verification key.

`open_session_v2` uses the submitted, validated policy for creation and the **stored** policy for renewal. Renewal cannot update permissions. A policy change invalidates unsubmitted authorizations approved under the previous policy. Existing strictly increasing session-expiry replay protection remains in place, with its documented renewal/recovery limitations.

The new program has no V1 `open_session` dispatch. The instruction discriminator and verification key both change. A V1 proof is not accepted through a compatibility fallback. Website verification defaults to context zero; verifying a pocket proof requires an explicit expected policy, session kind and deployment. The SDK computes consent before asynchronous proving and checks it again before building/sending a pocket request.

## Deployment boundary

This is a breaking **localnet candidate**, not an upgrade of the currently deployed devnet program. Current development program IDs are used by disposable local tests. The V2 facade refuses devnet/mainnet until a separate deployment is chosen, compiled, tested and recorded. Existing devnet app dependencies and deployment remain unchanged. Do not deploy this branch over the existing program or reuse its account state without an explicitly reviewed migration.

Program IDs bind a program namespace, not its binary or network genesis. Production still requires a verified network manifest, unique deployment identities, executable/key hashes, upgrade governance and independently verified proof setup. An upgrade authority can change program enforcement; this hash does not remove that trust.

Generated setup keys remain throwaway development material. The production ceremony must use the final frozen circuits. This change does not implement bot authentication, trusted consent UI isolation, multi-bot delegation, speculative trading, external audits or mainnet authorization.

## Required evidence

- A real proof opens a new pocket with exactly the approved policy.
- Substituting each policy field, a feed binding, home, session or domain fails; failed creation leaves no pocket behind.
- Cryptographically valid off-chain and other-deployment proofs fail at the Pocket instruction.
- V1 dispatch fails; normal rotation, revoke, recovery and atomic settlement still work.
- SDK and backend reject mismatched consent; all circuit public signals remain cryptographically bound.
- TypeScript, Rust, SBF/LiteSVM, packed consumer installation and a disposable-validator flow agree on the same fixture/proof contract.

## Local verification (2026-10-16)

- TypeScript build/typecheck and all 127 tests passed, including real circuit witness/proof checks with generated development artifacts present.
- All SBF programs built. Rust unit/vector/proof tests and nine LiteSVM flows passed. Additional focused runs verified home/domain substitution refusal and renewal preserving the stored policy when a different policy argument is supplied.
- Packed SDK/common archives installed in a clean external consumer; ESM, CommonJS dynamic import, declaration checking and a real intent signature passed.
- A disposable Agave validator completed registration, snapshot, local proof generation, backend verification, V2 opening, wallet-signed funding, atomic inventory-route fill and owner-proof sweep through the actual HTTP services.

The fill used the reference inventory planner and local test assets. This evidence is not a Jupiter trade, public-devnet deployment, independent audit or mainnet certification. Existing V1 devnet program and private app were not changed.
