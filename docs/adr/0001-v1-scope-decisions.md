# ADR 0001 — v1 scope decisions and deviations from the build plan

Status: accepted (v1 build). Each entry names the decision, why, and what
would revisit it. Anything here that tightens later is a normal change;
anything that loosens needs a design review.

Historical record through 2026-10-15. [ADR 0002](0002-open-source-review.md) supersedes the wallet facade, watcher recovery, funding-validation claims and account layout. References to audits here mean internal engineering review, not an independent security audit.

## Protocol

1. **Oracle feeds are pinned in the pocket policy** (`oracle_feeds`: mint →
   Pyth feed id + decimals). The plan left the mint→feed mapping open; a
   mapping chosen per-fill by the solver would let it pick a friendlier
   feed. Pinning it under the user's policy (changeable only through the
   24-hour timelock) closes that; `decimals` rides along so valuation
   never trusts a passed-in mint account.
2. **The input mint must have an oracle feed.** Valuing the daily cap
   requires pricing the input. Pockets hold USDC/SOL in practice; an
   input mint without a feed is refused (`NoInputOracle`). The no-oracle
   path (passkey + `no_oracle_cap`) applies to the *output* mint — the
   NFT-purchase shape.
3. **One session key per pocket; "passkey-signed" means a P-256 session.**
   The plan sketches passkey-on-demand over a software session, which
   needs a second on-chain key binding the proof does not carry. v1:
   a software session cannot exceed `big_action_threshold` nor buy
   no-oracle mints — the SDK opens a passkey session for those. Safe
   (conservative) and simpler to audit. Revisit: bind an optional second
   key in the login circuit (new public input) at the next circuit change.
4. **FillState seeds use the intent nonce, not the intent hash.** Anchor
   account init wants seeds from instruction args; the full intent hash
   is enforced anyway (`fill_end` recomputes and compares, nonce bitmap
   blocks reuse). Equivalent binding, simpler accounts.
5. **Registration message is printable ASCII** (`ghostlink:register:v1` +
   labelled lines) so every wallet can display it; the program accepts
   the raw bytes or the Solana off-chain-message framing (Ledger).
6. **Cluster string is a compile-time feature** of the registry program
   (`devnet` default, `mainnet` feature) so a message signed for one
   cluster can never register on another.
7. **Fills are SPL-Token-only in v1.** Token-2022 transfer hooks and fees
   interact with the balance-delta check; the census reads both programs,
   fills refuse Token-2022 accounts until that analysis is done (M3).
8. **Pyth only, no Switchboard,** parsed directly (owner + discriminator +
   layout checks against the receiver program) instead of linking the
   receiver SDK — smaller dependency surface for audit. Switchboard is an
   additive policy variant later. The receiver program id the pocket
   owner-checks against is `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`
   (verified against the live devnet accounts; an earlier typo in that
   constant made every real fill fail `BadOracle` until the pocket was
   upgraded). Devnet testing reads Pyth's sponsored push-feed accounts
   rather than pulling from Hermes, whose update endpoint is API-key
   gated; see docs/DEVNET.md.

## Implementation

9. **groth16-solana is pinned to a reviewed git revision** (`ac9d959…`):
   the crates.io 0.2.0 release predates the circom VK generator and the
   fixed `vk_gamma_g2` field name. Move to the next tagged release when
   it appears.
10. **Solana platform-tools pinned to v1.52** (`--tools-version`): the
    toolchain bundled with Agave 3.0.15 (rust 1.84) cannot parse current
    crates.io manifests (edition2024). Host toolchain pinned to 1.97.1
    (litesvm's MSRV).
11. **The indexer stores in memory with a JSON snapshot**, not Postgres as
    the plan sketched. The store is rebuildable from chain events by
    design and self-checks that every event chains (index + root). A
    Postgres adapter is a deployment option behind the same interface —
    queued for M2 hosting.
12. **The reference solver ships with a mock route** (fills from its own
    inventory), which is also what the M2 gate anticipates on devnet.
    The Jupiter planner drops into the same `RoutePlanner` interface for
    mainnet work.
13. **Demo wallet in the demo app** is an in-browser keypair so the flow
    runs with zero extensions; a Wallet Standard wallet replaces one
    `signMessage` function. Wallet-adapter integration + the Wallet
    Standard facade now exposes `standard:connect` and custom `ghostlink:signIn`;
    consumers must implement proof/challenge verification (ADR 0002).
14. **Program IDs** in source are the devnet/localnet deploy keys
    (keypairs held outside the repo, `~/.ghostlink/keys`). Mainnet IDs
    are minted at M4 with fresh keys and a coordinated `declare_id`
    change.

## Decisions from the 2026-10-15 internal audit

15. **Sessions must expire strictly later than every earlier session of
    the pocket** (`Pocket.max_session_expiry_slot`). A login proof binds
    (session key, expiry) but nothing fresh, so anyone who saw an
    `open_session` could resend it and reinstate a revoked session. The
    monotonic rule costs no circuit change; the SDK's default expiry
    (`currentSlot + sessionMaxSlots`) satisfies it naturally. Pocket
    accounts grew by 8 bytes (devnet redeployed; no mainnet yet).
16. **`fill_end` measures delivery on the account `fill_begin`
    snapshotted** (`FillState.out_account`). Anyone can create a second
    token account owned by a pocket; a solver that pre-seeded one and
    handed it to `fill_end` would have passed its standing balance off as
    delivery. Tested in `fill_flow_and_refusals`.
17. **Passkey assertions must carry user-verification (UV), not just
    user-presence.** "Passkey-held" in the policy rules means a
    biometric/PIN unlock, so the chain demands flag 0x04 as well.
18. **The identity message is cluster-bound and self-describing.** It
    names the cluster and tells the user never to sign it elsewhere,
    because the wallet popup is the master secret's only phishing
    control in v1. A device-held second factor (WebAuthn PRF) is the v2
    fix. Wallets that do not sign deterministically are refused unless
    the integrator opts into an unrecoverable random secret.
19. **`verifyLogin` is not a bearer-token check.** It requires a root
    source, canonicalizes every public signal (one app id per identity,
    never "0"-padded variants), binds the proof to the announced session
    key + expiry and home when asked, ships the verifying key it was
    built against, and never throws on malformed input. Authentication also
    requires verifying a session signature over a fresh server challenge
    and atomically consuming that challenge; the public proof alone is copyable.
20. **Events are attributed by program framing, not by discriminator.**
    `decodeLogs` tracks invoke/success frames and accepts an event only
    from its rightful program at depth 1, since any program can emit a
    byte-identical `Program data:` line. The indexer store checks index
    and root before mutating, treats identical redeliveries as no-ops,
    persists poller cursors, and the webhook requires a shared secret,
    drops failed transactions and reconciles every root with the
    on-chain ring. Paths are O(depth) (full levels kept), not O(n).
21. **Paid services meter their spend.** The relayer keeps a rolling
    daily budget, may restrict pocket creation to partner origins, and
    creates the home's missing token accounts inside a sweep; the
    reference solver values both legs and refuses to deliver more than
    the input is worth (an `inMax: 0` intent would otherwise drain its
    inventory) and no longer pays rent for pocket output accounts.
22. **`circuits/keys` is committed** (public verifying keys and fixture
    proofs). The generic `keys/` ignore rule had swallowed it, and CI's
    throwaway setup can never match the committed Rust constants, so the
    Rust job verifies the committed keys instead of downloaded ones. A
    circuits test pins every verifying-key IC point as finite and checks
    the fixture proofs break when any public signal changes.
23. ~~Intent nonces are a lifetime bitmap of 2,048 per pocket.~~
    Superseded by 25.

## Decisions from the follow-up pass (2026-10-15, same day)

24. **The identity is derived from a Sign-In-With-Solana message naming
    GhostLink's own domain**, signed through the wallet's native
    `solana:signIn` when it has one (Phantom, MetaMask and others render
    the domain and warn on a mismatch — a warning, not a hard block, per
    their published behaviour) or through `signMessage` over the
    byte-identical text otherwise, so the same wallet yields the same
    secret either way. A wallet that injects a nonce/timestamp into the
    sign-in text is detected (two sign-ins differ) and the plain path is
    used. An optional **passkey factor** (WebAuthn PRF over a fixed salt)
    is mixed into the secret: `SHA-256(tag ‖ SHA-256(sig) ‖ prf)`. The
    choice is made at registration and cannot be rotated later (the
    registry is append-only and the circuits have no revocation); the
    dashboard says so. PRF support cannot be exercised in CI (no
    authenticator); it is covered by code review and manual testing.
25. **Intent nonces are a sliding window** (`Pocket.nonce_base` + the
    2,048-bit bitmap): any value in the window once, in any order; a
    larger value slides the window forward and retires what it leaves
    behind, so a per-pocket counter runs forever. Below-window values read
    as used, which keeps old signed intents dead. Pocket accounts grew by
    another 8 bytes (devnet redeployed).
26. **The watcher cranks `execute_change`** when given a fee-payer keypair,
    so a user holding no SOL still gets their own timelocked change
    applied. The instruction is permissionless by design (authorization
    happened at propose time); the watcher only learns of proposals it
    has ingested. The October 16 implementation backfills history and can
    persist its cursor/pending changes with `WATCHER_STATE_PATH`.
27. **A test-only CPI caller program** (`programs/cpi-caller`, never
    deployed) proves every state-changing instruction refuses to run under
    another program — the control the threat model had listed as queued.
28. **Witnesses can be built locally.** `GET /leaves/:tree` pages the
    leaves; the SDK's `localWitness` rebuilds the tree in the browser and
    reads the path off it, so the indexer sees no wallet-specific request.
    The dashboard uses it below 20,000 leaves (a 26-hash append per leaf
    in JS); larger trees fall back to the path endpoint, which is then the
    indexer operator's privacy trust, documented as such.
29. **Blink metadata carries `pocket`** and the SDK's `verifyFunding`
    refuses an endpoint that names any other pocket than the one it
    derived. This checks metadata only; the eventual transaction's recipient
    and instructions still need validation before wallet signing.

## Explicitly out of scope for v1 (unchanged from the plan)

- Shielded pools / private transfers (legal review first).
- Designated-verifier proofs.
- Rate-limiting nullifiers and cross-app reputation (the `owner_tag`
  separator stays reserved so they can be added without re-registration).
- Pay-out intents ("send to address X") — nothing moves anywhere but
  home outside an atomic fill.
