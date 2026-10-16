# ADR 0004: bounded speculative buys and tracked exits

Status: implemented development candidate, 2026-10-17. Localnet only, no independent security review or public deployment. This supersedes ADR 0001's passkey-only unpriced-output rule for the new account version. Existing deployments are unchanged.

## Decision

`PocketV3` has its own Anchor discriminator and a 3,293-byte allocation. Its policy uses the `ghostlink:policy:v3` hash domain and includes an optional `speculative` permission. An omitted permission disables all unpriced trades, including those signed by a passkey. The existing 12-input V2 login circuit and `open_session_v2` instruction bind this new policy hash; the proof shape, intent format and verification keys do not change. New deployment identities and an explicit migration remain required. Never upgrade the preserved V1 deployment with this layout or interpret old account padding as new state.

The owner explicitly chooses:

- `noOracleCapUsdE6`: maximum priced input value for each speculative buy. A software session also stays under `bigActionThresholdUsdE6`.
- `speculative.dailyBuyCapUsdE6`: total acquisition spend per daily slot window, in addition to the normal daily cap.
- `speculative.maxCostExposureUsdE6`: aggregate remaining historical acquisition cost. This is **not** the current market value of held tokens.
- `speculative.maxPositions`: 1–8 simultaneously held unpriced assets.
- `speculative.baseMints`: 1–4 distinct assets with owner-pinned oracle feeds. The output allowlist, if present, must include every base so exits remain possible.

Only classic SPL tokens are supported. Enabling speculative trading does not enable Token-2022, arbitrary transactions, NFT marketplace actions, unsupported DEXes or launchpads. Maximum vector counts are allocation bounds; a concrete policy and instruction must also fit Solana's transaction-size limit.

## Settlement and accounting

The policy determines the trade class. Two priced legs retain the oracle floor and daily-spend rules. A speculative buy spends an approved priced base into an unpriced asset. An exit spends an acquired unpriced asset back into its original base. Two unpriced legs are refused. Every speculative intent must spend and receive positive quantities and retain its exact signed minimum output, nonce and deadline.

`fill_begin` checks authority, fresh input prices for buys, all budgets, and position capacity before transferring input. `fill_end` records the measured output delta, its token-account address, original base and full acquisition cost. Existing deposits do not become an acquired position. Further buys of the same asset must use the same account and base. The ledger has eight fixed entries; additional position accounts or per-trade rent are unnecessary.

An exit may spend no more than the recorded acquired quantity from that exact account. Output must enter a pocket-owned token account in the original base with a fresh pinned price. Its signed minimum is enforced, but acquisition cost is not a minimum sale price: loss-taking and stop-loss exits must remain possible. There is no oracle claim about the unpriced asset and no guarantee that a quote or signed minimum is fair.

Partial exits release `floor(remaining_cost * sold_quantity / remaining_quantity)`. Rounding retains exposure; the final exit releases the exact residual cost and clears the entry. Exits do not refund daily acquisition spend or charge an invented input USD value. `Filled.mode` identifies priced trades (0), speculative buys (1) and tracked exits (2); input USD value is zero for mode 2 and released historical cost is reported separately.

The entire buy/exit, token movement, nonce, budgets and temporary fill account commit or revert together. Network fees can still be charged on failure.

## Administrative transitions

Session renewal, rotation and revocation preserve positions and spending. Daily rollover resets only the two daily counters, never exposure. Sweeping a tracked token account home clears its position, including permission to sell subsequently redeposited tokens; sweeping a different account does not clear it. Recovery remains available through an owner proof after session expiry or revocation.

New fills require the pocket to control closure of the output account. Previously deposited accounts may retain a foreign close authority after an SPL ownership transfer. Recovery transfers their tokens home and clears their position without attempting an unauthorized close. Their rent remains in the empty account; ordinary pocket accounts are closed and refund rent as before.

Proposing a policy change immediately blocks new speculative buys. Exits and recovery remain available. Execution requires both the existing 24-hour timelock and no open speculative positions. This prevents changing feeds, bases or permissions beneath an existing position. Canceling a pending change preserves all budgets and positions. Home changes retain their existing owner authorization and timelock.

## Solver and integration boundary

`SOLVER_ALLOW_UNPRICED=1` is a separate operator opt-in. Unpriced trades also require a planner declaring `funding: "intent-input"`: its output must come solely from exchanging the exact intent input. The reviewed Jupiter adapter satisfies this contract; the inventory test planner does not. A custom adapter must establish this invariant in code and tests before making the declaration. A provider quote is never substituted for an oracle valuation of solver inventory.

All policy fields cross the canonical hash, Borsh instruction encoding, SDK JSON conversion, relayer validation, bot consent storage and confirmed-account reader. The trusted owner UI must explain the limits and potential total loss before public use. The private product UI has not been migrated by this candidate.

## Evidence and remaining gates

- Real SBF/LiteSVM tests verify owner-proof field substitution, bounded buys, loss-taking partial/full exits, underfill rollback, direct-deposit refusal, renewal/day rollover, policy freeze/timelock, recovery and sweep/redeposit refusal.
- Ledger arithmetic tests cover rounding, maximum integers, capacity, exact account/base binding and preserved daily budgets.
- The complete SDK/bot/solver flow passed against cloned Jupiter/Raydium CP programs on a disposable validator with `SPECULATIVE_TRADING=1`. No output-asset oracle is configured. The test verifies acquired quantities/cost, partial release, restart/retry, market-move rollback, revoke and owner recovery. Quotes and base prices are synthetic.

Actual provider responses, device/owner-UI acceptance, malicious-liquidity/price-impact review, external security review, production ceremony, fresh deployment governance and a capped pilot remain open. See [the release gates](../MAINNET-READINESS.md) and [routing test instructions](../JUPITER-ROUTING.md).
