# Experimental Jupiter routing

The solver has an opt-in composable Jupiter adapter for one approved Raydium CP pool per trade. It validates both directions of a classic SPL token pair. It is development software, not a mainnet release: the V2 solver still rejects public-chain genesis hashes. The default planner remains the local inventory fixture.

## Configuration

Set `SOLVER_ROUTER=jupiter-raydium-cp`, `JUPITER_API_KEY_PATH` to a private file containing the API key, and `JUPITER_POOLS_PATH` to a private JSON file with an array of pool approvals. Each entry contains `pool`, `token0`, `token1` (base58 addresses in the pool's on-chain order), and `maxTradeFeePpm` (combined trade and enabled creator fees in millionths, at most 50,000). Approval of a pool permits either direction of its pair; the signed intent still determines the direction and amounts. No pools are implicitly trusted or shipped as production recommendations.

`JUPITER_SLIPPAGE_BPS` defaults to 50 and accepts 0 through 500. The user's signed minimum output takes precedence whenever stricter. Existing solver price, authorization, compute, priority-fee, network-fee and journal configuration still applies. Jupiter routing does not enable unattended trades in unpriced assets or bypass Pocket policy.

The fixed-origin client calls [Jupiter's composable build endpoint](https://developers.jup.ag/docs/api-reference/swap/build), requests transaction version 0, exact input, no wrapping, no platform fee, and the pocket's derived output token account. It sends the key only to `api.jup.ag`, refuses redirects, aborts after four seconds, caps the streamed body at 256 KiB and redacts provider/transport errors. It has no automatic provider retry: retry the identical signed intent through the durable submission path.

## What the adapter checks

- Quote mints, input amount, output minimum, explicit tolerance, one 100% Raydium CP step and an operator-approved pool.
- `route_v2` or `shared_accounts_route_v2` instruction bytes, one RaydiumCP enum step, exact amounts, no platform or positive-slippage fee, and no trailing instruction data.
- Every account and privilege: solver source ATA, pocket destination ATA, Jupiter authority and event PDAs, SPL programs, Raydium authority, pool/config, correct directional vaults, mints and observation account. The only transaction signer is the solver. Shared accounts must be the derived Jupiter ATAs; the final output can never be redirected from the pocket.
- RPC-owned pool/config/observation layouts, approved mint identities, initialized classic SPL mints without freeze authority, token owners, no delegates/close authority, active token state and pool fee ceiling. Pool mapping is rechecked with the other accounts in a single confirmed bank. The resulting context becomes a minimum for transaction composition.
- No tips, cleanup or auxiliary instructions. The only accepted provider setup is a redundant idempotent creation of the solver input ATA; those bytes are discarded and the server supplies its own creation instruction. The pocket output account and any Jupiter shared accounts must already exist. This avoids paying user-controlled output rent.
- Provider compute suggestions are discarded. Lookup mappings are bounded and independently verified at finalized commitment by the transaction composer. The full atomic begin/swap/end message is simulated twice; its exact network fee, compute budget and blockhash lifetime are checked before signing and journaling.

Already wrapped SOL may be a classic SPL leg; this adapter never wraps, unwraps or closes token accounts. Token-2022, freezable mints, arbitrary intermediate accounts, split/multi-hop routes, legacy Jupiter instructions, exact-out trades, other DEXes and launchpads are refused. Missing liquidity or an unsupported provider response returns a preparation failure, never a fallback arbitrary transaction.

Pool fees are checked against the observed bank, not locked by a new on-chain fee instruction. The atomic Pocket output floor protects the delivered amount; network fees can still be charged on failed transactions. Program upgrades, price impact, inventory exposure, aggregate fee budgets and RPC integrity require separate operational controls. A passing simulation is not a substitute for those controls.

## Evidence and remaining release gates

Contract tests cover both directions and direct/shared account variants, malicious instruction/account substitutions, fees, authorities, pool changes, stale contexts, malformed responses, oversized streamed bodies, provider failure and timeout. Fixtures are synthetic and are explicitly labelled as such. They do not establish a live Jupiter quote, completed swap, commercial bot integration or mainnet readiness.

Account ordering was cross-checked against the official ABI and the Raydium CPI in a confirmed public transaction ([2d1A2pdD…](https://explorer.solana.com/tx/2d1A2pdDExuPU2DsuLEEA6xFYZ8TZyZTDLJp6NeQPCUU8zhH2aWCFtSbxf3op3ibkR8jCNraUdkWpaHiRm81vzZU)). That transaction contains an unsupported multi-hop/Token-2022 route and is reference evidence only, not an accepted GhostLink fill.

Before enabling a public release, collect real build responses with an operator-owned Jupiter key and validate buy/sell transactions against reviewed program binaries and a reproducible local fork, including failures, rent and complete GhostLink atomic settlement. Record binary hashes, upgrade authorities, account snapshots and provider versions. Then complete the independent security review, production proof ceremony, controlled deployment and capped pilot in [MAINNET-READINESS.md](MAINNET-READINESS.md). Never remove the V2 public-genesis guard merely to test routing.

ABI/layout references reviewed on 2026-10-16:

- [Jupiter aggregator IDL](https://github.com/jup-ag/rfq-v2-sdk/blob/f3f30ff2af48f63c11f326a486b8b0eb9611714f/fill-decoder/idls/aggregator.json), including V2 route instructions and RaydiumCP enum variant 46.
- [Jupiter DEX interface accounts](https://github.com/jup-ag/jupiter-amm-implementation/blob/cc068c9d1df0060c62f9a8a4fc37ea13ea7b9b39/idls/jupiter_dex_interfaces.json) and [authority derivation](https://github.com/jup-ag/jupiter-amm-implementation/blob/cc068c9d1df0060c62f9a8a4fc37ea13ea7b9b39/jupiter/src/lib.rs).
- [Raydium swap accounts](https://github.com/raydium-io/raydium-cp-swap/blob/b3187ae53a1b95a201f855a59024a12ca8f5b51a/programs/cp-swap/src/instructions/swap_base_input.rs), [pool layout](https://github.com/raydium-io/raydium-cp-swap/blob/b3187ae53a1b95a201f855a59024a12ca8f5b51a/programs/cp-swap/src/states/pool.rs), [fee config](https://github.com/raydium-io/raydium-cp-swap/blob/b3187ae53a1b95a201f855a59024a12ca8f5b51a/programs/cp-swap/src/states/config.rs), and [observation layout](https://github.com/raydium-io/raydium-cp-swap/blob/b3187ae53a1b95a201f855a59024a12ca8f5b51a/programs/cp-swap/src/states/oracle.rs).
