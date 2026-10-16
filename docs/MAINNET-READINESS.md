# Mainnet readiness and compatibility plan

Status: development release, 2026-10-16. **Not approved for real funds.** This document defines the implementation and evidence needed for a release; planned entries are not shipped features. The public repository contains protocol code and integration documentation only. Product application code, design assets, credentials and internal handoffs remain private.

## Product scope

GhostLink has two paths: application login/eligibility proofs and constrained spending from a separate pocket. An off-chain login need not create a pocket or submit a transaction. A bot's trading session is authorized once and reused until expiry or revocation; generating an identity proof for every trade would put unnecessary latency in the trading path.

Support is an explicit contract per network, operation, token program, wallet, execution route and runtime. No claim of universal compatibility is possible. Existing bot and website operators must integrate; the SDK cannot install itself into another company's service.

## Compatibility inventory

| Use case | Current boundary | Required work / acceptance evidence |
| --- | --- | --- |
| Node.js Telegram trading bot | Localnet `@ghostlink/bot` authenticates consent, encrypts keys/orders, allocates nonces durably and checks confirmed permissions before signing; solver preserves exact submissions | Trusted owner UI, strategy/operations layer, end-to-end verified devnet deployment and bot test |
| Telegram Mini App | Backend HMAC/freshness validation and immutable consent request API tested with synthetic Telegram data | Real Telegram iOS/Android/Desktop wallet handoff, trusted origin registry and owner consent display |
| Existing commercial sniper bots | No named provider integration or endorsement | Operator integration and tests against its supported extension/API model; do not request wallet-key imports as a workaround |
| Web trading terminal | Devnet product integration exists | Mainnet route, quote validation, supported asset registry, fee budgets, production observability |
| Liquid-token market swaps | Classic SPL inventory settlement; experimental [Jupiter/Raydium CP adapter](JUPITER-ROUTING.md) validates one approved hop in both directions, with version-0 composition and complete-message simulation | Real provider quotes, reviewed program snapshots and complete atomic buy/sell/failure evidence; wider DEX variants need separate review |
| New-token sniping | Blocked for unattended software sessions; input needs an oracle and unpriced outputs need passkeys | Versioned speculative trading policy and buy/sell paths, explicit opt-in, bounded exposure, price-impact/route controls, independent review |
| Bonding curves / launchpads before aggregator routing | No direct adapters | Separate adapters for each launch program and migration phase; liquidity/authority checks; realistic transaction-size tests |
| Copy trading | Same intent primitives; no trigger engine | Durable leader-event ingestion, idempotency, per-follower caps, stale-signal refusal and session expiry handling |
| DCA / scheduled trades | No scheduler | Persisted jobs, time/price bounds, session renewal and restart recovery |
| Limit orders / stop loss / take profit / trailing stops | No trigger/order service | Explicit cancellable order authority, fresh triggers, partial-fill semantics; no guaranteed execution or price during gaps |
| Concurrent strategies / several bots | One active session per pocket; a new session replaces it | Distinct pockets/app namespaces or versioned multi-delegation accounts; per-bot revoke/budgets and a durable shared nonce allocator |
| SOL | SPL transfers only | Explicit wrapped-SOL setup, rent, close/refund accounting; native SOL is not a valid token-account swap leg |
| Token-2022 | Census reads some balances; Pocket settlement rejects Token-2022 accounts | Per-extension support policy; transfer fees, hooks, permanent delegates, frozen/default states and mint-account validation; unknown extensions refused |
| NFTs / compressed NFTs | General NFT marketplace actions not implemented | Separate asset models and narrowly scoped instructions; an SPL token balance is not generic NFT compatibility |
| Lending, staking, perps, leverage, liquidity provision | Not expressible as the existing two-token intent | New audited action types and position/risk accounting; never add arbitrary transaction signing to simulate compatibility |
| Merchant payments / subscriptions / transfers | Withdrawals go home; no arbitrary recipient payout | Separate consent and payment policies, destination binding, recurring mandate limits; not enabled by swap permissions |
| Website login | Proof verifier and custom wallet feature exist | Host issues and atomically consumes a signed challenge; session/domain/root/expiry validation; stable app namespace |
| Token-gated sites or Telegram groups | Historical holdings claim exists | Fresh snapshot policy, supported mint/census coverage, authenticated account binding and membership rechecks; no exact live-balance guarantee |
| Membership, tickets, credentials, reputation | No generic claims engine | Define issuer/revocation model and new circuits/contracts for claims beyond current token holdings |
| Existing Connect Wallet / SIWS | Custom ghostlink:signIn only | Explicit application integration; a PDA cannot produce an ordinary wallet's Ed25519 signature |
| Mobile wallets / hardware wallets / passkeys | Wallet Standard/message-signing primitives; no exhaustive device certification | Real device tests, deterministic signature compatibility, rejected/changed account flows, lost-factor recovery |
| Python / Rust / Go bot backends | Wire schema and some Rust encodings; no supported full client libraries | Published canonical vectors, language SDKs or a narrowly scoped local signing service; never upload owner identity for convenience |
| EVM / other chains / bridges | Solana-specific protocol | Separate deployments, proof/domain separation and bridge risk model; not compatible by changing an RPC URL |
| Offline / stale RPC / reorg / provider outage | Some retries and finalized indexing exist | Explicit pending/confirmed/failed/expired/unknown states; fail closed on stale or conflicting authorization data |

## Protocol decisions needed before sniper support

The current Pocket program always values the input through a pinned feed. It only permits oracle-less output for a passkey session under the no-oracle cap. Consequently, acquiring an unpriced token does not establish a supported route to sell that token back. This must be solved as a round-trip protocol design, not a UI toggle.

Proposed separate speculative policy (not implemented): fund a dedicated small pocket, authorize specified strategies for a short expiry, constrain base assets and absolute spend per trade/day, bind every signed trade to its exact output floor and deadline, and set an explicit exposure budget. Define how selling unpriced inventory consumes budget without trusting the solver's claimed valuation. Decide whether the protocol accounts for cost basis, per-mint unit limits, or a separately capped exit permission. Quote pricing alone must not be represented as a trustworthy oracle. Minimum output protects the signed intent but does not prove a fair market price.

Do not weaken existing oracle/passkey rules to obtain broad token coverage. Introduce a versioned layout, explicit migration and new audited tests. Include malicious low-liquidity routes, manipulated quotes, repeated round trips, stale feeds, token decimals, budget exhaustion, session compromise and recovery races.

V1 has one active key per per-origin pocket. Bots hosted at one origin can otherwise replace each other's sessions. An isolated identity broker needs a verified application registry and a derivation/consent model that separates bot identities while keeping the owner secret away from third-party page scripts. Raw caller-supplied origin strings are not an isolation boundary.

The delegated authorization API accepts Ed25519 only. A bot-supplied P-256 key and a syntactically valid WebAuthn assertion do not prove that a physical authenticator held the secret. Keep passkey creation/authorization in the trusted owner context, and define the attestation/trust policy before relying on it for stronger mainnet permissions.

**Initial-policy binding:** the V2 candidate adds a purpose/deployment/policy/session-kind context to the login proof and requires `open_session_v2`. The program re-derives the context from the submitted initial policy or stored renewal policy. Off-chain login has a separate context. This breaking candidate remains localnet-only; the existing V1 devnet program is preserved. Local circuit, SDK, SBF/LiteSVM and full validator checks passed. Independent review and fresh-deployment verification are still required before closing the gate. See [ADR 0003](adr/0003-session-authorization-v2.md).

## Mainnet release gates

| Gate | Current status | Evidence required to close |
| --- | --- | --- |
| Production proof setup | Development keys; no completed production ceremony | Freeze circuit/compiler hashes; independent phase-2 contributions, verified transcript and published artifact hashes; replace both login/owner keys together and regenerate verification constants |
| Independent security review | Internal review only | External circuit, program, SDK authorization, route composition and operational review; material findings resolved and retested |
| Deployment identity | Constants are development program IDs | Versioned network manifest with genesis, program IDs, account layout, program-binary hashes and proof hashes; verify executable code and upgrade authority on chain |
| Upgrade / migration governance | Production decision pending | Document multisig/timelock or immutability decision, authority custody, incident response, old-pocket exit and migration; no accidental upgrades |
| Bot authorization boundary | Public-key SDK and backend request/storage/chain checks locally verified | Trusted owner UI and application registry, real Telegram/device acceptance, on-chain revoke/rotation UX and external review |
| First-pocket policy authorization | V2 binding locally verified; not deployed or independently reviewed | Circuit/program/SDK substitution tests, local validator evidence, external review and fresh-deployment migration |
| Trading route | Inventory reference flow verified; opt-in Jupiter/Raydium CP adapter has adversarial contract tests | Live mainnet read-only quotes, reviewed binary/account snapshots, fork buy/sell/failure tests and approved bounded real settlement tests after audit gates |
| Asset and oracle support | Classic SPL with pinned feeds | Explicit supported mint/feed/decimal list, staleness/confidence rules, unsupported token refusal, Pyth update availability and costs |
| Submission reliability | Encrypted bot nonce/order reservations and exact-transaction journal tested through restart; version-0 messages, verified lookup tables, simulation, per-message network-fee limits and nonce-window backpressure | Validated DEX instructions/protocol fees, coordinated restore, aggregate budgets, live route failure tests and operator RPC guarantees |
| Persistent operations | SQLite consent/key and solver transaction records survive process exit; lost-acknowledgment/restart flow tested | Backup/restore drill, key rotation, RPC failover, alerts, fee/inventory budgets and durable strategy jobs; no multi-host availability claim |
| Distribution | Source and locally packed archives; no registry release implied | Scope ownership, versioned signed/provenance-backed releases, immutable checksums, packed consumer install/type/runtime tests and dependency review |
| User recovery | Recovery primitives exist; known liveness caveat | Lost-session/device tests, home withdrawal checks, compromised-session race handling, clear owner recovery procedure and support playbook |
| Pilot acceptance | Not started | Supported wallet/device and strategy matrix, agreed amount/user caps, monitoring, successful exit/revoke and incident rehearsal |

`GhostLink.init` now permits only localnet for the V2 candidate; no V2 devnet/mainnet deployment is verified. Removing that check alone does not satisfy any gate. Low-level encoders remain usable for tests and do not themselves verify RPC identity.

## Build order

1. **SDK distribution and delegation foundation:** installable SDK/bot companion archives, external-consumer tests, public bot-key authorization and candid capability documentation. Locally verified; registry publication remains gated.
2. **Trusted onboarding:** backend authentication, immutable requests, encrypted storage and confirmed state checks are implemented in the localnet candidate. The local validator exercised consent, owner proof, activation, backend restart, bot-signed inventory fill and owner sweep. Finish the isolated owner UI, real Telegram/device handoff, visible permissions, rotation and on-chain revocation. Keep identity proving local. See [bot backend contract](../packages/bot/README.md).
3. **Liquid-token execution:** the experimental Jupiter/Raydium CP planner validates one approved classic-SPL hop and both trade directions. Complete real provider-response and fork execution evidence, route failure/expiry recovery, then expand DEX variants individually. See [routing boundaries](JUPITER-ROUTING.md).
4. **Bot operations:** the bot now persists per-pocket nonce reservations and exact signed orders, and the reference solver reconciles exact transactions across restarts. Finish copy/DCA/conditional triggers, execution-level cancellation, strategy caps and coordinated backup/restore. Local cancellation cannot recall released signatures. Pre-authorize before the trading trigger; do not make cold proof generation part of every trade. See [transaction recovery](TRANSACTION-RECOVERY.md).
5. **Speculative trading protocol:** decide and implement the bounded oracle-less buy/sell policy and multiple-bot isolation; migrate explicitly. This is a separate audited release, not a config flag.
6. **Additional token programs and actions:** support named Token-2022 extensions and direct launchpad adapters separately; maintain refusal tests for everything unreviewed.
7. **Production release:** ceremony, external audits, deployment manifest/governance, operations rehearsal, package publication, then a capped mainnet pilot. Expand supported cases only after their acceptance tests pass.

Measure onboarding (cold navigation through confirmed authorization), signing latency, quote latency, submission-to-confirmation p50/p95 and failure/reconciliation rate separately. User approval time and chain congestion must remain visible. No guaranteed first-slot execution, profit, or universal sub-five-second confirmation claim is made.

Named provider findings and priorities: [bot compatibility research](BOT-COMPATIBILITY.md).

## Current external integration references

- [Jupiter Swap API](https://dev.jup.ag/docs/swap): the Router `/swap/v2/build` path supplies composable instructions. GhostLink needs its own checks before and after the route, so an assembled, unmodifiable Meta-Aggregator transaction is not a drop-in integration. Confirm the current schema and API credentials when implementing.
- [Telegram Mini App validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app): validate initData at the backend, including freshness. This proves Telegram context, not wallet ownership or permission to trade.
- [Solana token extensions](https://solana.com/docs/tokens/extensions): extension behavior varies; enumerate supported extensions instead of treating all Token-2022 mints as equivalent.
- [Jito transaction submission](https://docs.jito.wtf/lowlatencytxnsend/): optional landing/bundles are a transport integration. GhostLink's fill begin and end must still be in the same transaction; do not split them across a bundle.
