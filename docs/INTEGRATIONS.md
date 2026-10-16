# Integrating GhostLink with bots and applications

This is an experimental V2 localnet integration contract. See [mainnet readiness](MAINNET-READINESS.md) before planning a real-funds launch and [SDK installation](../packages/sdk/README.md) for local archives. There is no claim of compatibility with a named third-party bot until its operator integrates and verifies the flow.

## Telegram bot and Mini App flow

1. The bot backend authenticates its Telegram webhook/update source. If it uses a Mini App, it validates Telegram `initData`, its age and expected bot; never trust `initDataUnsafe` or a chat ID supplied by the browser.
2. The backend creates a session signer scoped to that user and bot. Persisting it across restarts requires protected server-side key storage; never send the private session key through Telegram messages, URLs, analytics or the user's browser. A hardware-backed signer may implement `SessionSigner` if it produces the required signature format.
3. Create a cryptographically random, short-lived authorization request ID. The server record binds the authenticated Telegram user, application origin, session public key, intended pocket, chain/deployment, requested policy, home and expiry. The link carries only an opaque identifier. Fetching a link does not approve it.
4. In a separately trusted owner context, show those permissions. Derive the owner's identity and generate the proof locally with `authorizeSession`. Never put the identity secret in a third-party bot Mini App or backend. The SDK is not itself an isolation sandbox; a hosted origin-enforcing broker is still required for untrusted integrations.
5. Submit `openSession` and wait for confirmation. The bot independently checks the RPC genesis/deployment, program ownership/layout, pocket, session key/expiry and active policy. Atomically mark the one-use request complete for that authenticated user; a replay or another user's callback must fail.
6. Before trading, obtain a quote and check the supported token programs, on-chain policy, fresh oracle data, output amount, deadline, liquidity and fees. Reserve a nonce durably per pocket. Sign the canonical intent and submit through the reviewed solver.
7. Reconcile the transaction on chain before reporting success. A transport timeout is an unknown outcome, not permission to create a second trade. Persist the intent hash, nonce, signature if known, and state. Retry/reconcile the same intent; never silently issue a new nonce for an uncertain prior trade.
8. Stop on session expiry/replacement, policy change, stale data or insufficient budget. Renewal needs fresh owner authorization. Support revoke and sweep-home recovery, and explain the current compromised-session recovery race documented in ADR 0002.

The installed SDK provides public-key descriptors, local proof preparation, intent signing and explicit submission/status clients. The separate bot backend supplies Telegram authentication and encrypted consent/key storage; the reference solver supplies an encrypted transaction journal and restart reconciliation. The trusted product UI, bot-side nonce allocator, strategy scheduler and live DEX route remain unfinished. See [transaction recovery](TRANSACTION-RECOVERY.md). No bot token is needed in the public SDK or browser bundle.

The V2 candidate binds the approved policy, session kind and program IDs into the login proof and uses `open_session_v2`. A login-only proof cannot activate spending. This is not yet deployed: the existing devnet app remains on V1. See [the protocol/migration decision](adr/0003-session-authorization-v2.md) before integrating.

For named-provider findings and implementation priorities, see [bot compatibility research](BOT-COMPATIBILITY.md).

## Trading adapters

Keep route discovery and signing separate. A strategy proposes exact input/output bounds; a solver planner produces instructions. Validate the program/account/signing set and destination, and compose signature verification, `fill_begin`, the route, and `fill_end` in one transaction. Reject unexpected authorities, destination substitutions and unsupported token programs. The chain enforces the session, policy, nonce, deadline and actual output balance change.

Versioned transactions, lookup tables, compute limits and bounded priority fees need implementation before complex mainnet routes. A solver fee payer must have an explicit fee/rent budget. Do not finance attacker-controlled account creation without an abuse model. Route setup, refunds and wrapped-SOL cleanup must not withdraw the pocket's unrelated balances.

Jupiter's current [Router API](https://dev.jup.ag/docs/swap) is the candidate for composable swaps. Other aggregators, direct pools and launchpad programs require individual adapters. A bot that only imports a normal wallet private key is not compatible with a Pocket PDA; exporting the owner's key defeats the authorization design.

## Login and access gates

Issue a random backend challenge, store its intended app/session and short expiry, verify the returned proof with `@ghostlink/verify`, then verify the proof-bound session signature over `loginChallengeDigest(challenge)`. Consume the challenge atomically before issuing the site's own session cookie. Check domain, session expiry, chain roots and all requested claim fields. A copied valid proof is not a bearer login token.

For a token gate, require the intended mint, threshold and snapshot freshness. A holdings proof concerns a recorded snapshot; it does not lock tokens or guarantee that the user still holds them. Telegram membership/access removal requires the integrating bot to recheck eligibility and manage its own permissions. Do not turn a login proof into trading consent.

## Acceptance tests for each integration

| Boundary | Required observable behavior |
| --- | --- |
| Installation | Clean external Node project installs reviewed archives, imports SDK and resolves TypeScript types without workspace links |
| Authorization | Bot-key substitution, wrong Telegram user, expired or replayed request, wrong app/domain and wrong chain are refused |
| Secrets | Owner identity/witness never reach bot/backend/logs; only public descriptor and proof cross the intended boundary |
| Session | Old key stops after rotation; expired/revoked keys fail; existing policy cannot be replaced by a renewal request |
| Trading | Real supported route delivers at least the signed minimum; failed route leaves no partial pocket spend |
| Assets | Unknown program/extensions/feed bindings refused; decimals, fees and rent accounted for correctly |
| Retries | Duplicate commands and timeout-after-broadcast do not create a second trade; restart preserves nonce and pending outcomes |
| Recovery | User can inspect policy, stop new orders and recover funds through the documented owner path; exercise known racing-session limitation |
| Mobile | Real Telegram iOS/Android/Desktop and supported wallet handoffs work; reject/close/account-switch paths recover cleanly |

Record revision, network, wallet/runtime, route and actual confirmed signatures for on-chain tests. Fixture/unit tests are useful but must not be presented as a live Telegram, DEX or mainnet certification.
