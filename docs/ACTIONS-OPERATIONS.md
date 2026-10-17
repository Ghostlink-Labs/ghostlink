# Funding Actions service

The Actions endpoint constructs an **unsigned** deposit transaction. The user's wallet pays, signs, submits and tracks it. The service holds no wallet key and never broadcasts. This V2 candidate is verified on disposable local validators and refuses known public devnet/mainnet genesis hashes until a reviewed deployment migration exists.

## Approved chain and configuration

- `ACTIONS_GENESIS_HASH`: required, independently approved full genesis hash. The hosted service verifies it through the bounded [RPC pool](RPC-OPERATIONS.md) before listening.
- `RPC_ENDPOINTS_PATH` or `RPC_URL`: operator-approved providers. Requests cannot choose the RPC or expected chain.
- `BASE_URL`: the public HTTPS origin used for metadata links; loopback HTTP is allowed for local development. Paths, credentials, query strings and fragments are refused. The default is `http://localhost:<PORT>` and must be set for hosted use.
- `PORT`: public HTTP port, default 8790.
- `OPERATIONS_PORT`: separate loopback-only metrics port, default 18790.
- `ACTIONS_MAX_IN_FLIGHT`: deposit preparations, default 8, allowed range 1–64. Overload is refused without queuing.
- `TRUST_PROXY`: leave disabled unless a controlled proxy overwrites forwarded addresses.

Legacy `CLUSTER=devnet` or `mainnet-beta` is refused. An environment label does not establish the connected deployment. The Actions `X-Blockchain-Ids` header derives from the approved genesis using the [Solana CAIP-2 rule](https://namespaces.chainagnostic.org/solana/caip2), rather than defaulting to devnet. It accompanies metadata, preflight and error responses. The service uses the [Actions specification's](https://solana.com/docs/tools/actions) `{ "message": "..." }` error shape, including parser, not-found and overload errors; provider diagnostics remain opaque. Other GhostLink services retain their existing error field.

## Deposit validation

`GET /actions/fund/:appIdHex` exposes the locally derived Pocket PDA. Metadata is disabled while readiness fails and is never cached. It does not prove ownership, inspect the pocket on each metadata read, or approve a later transaction returned by a different endpoint.

`POST /actions/fund/:appIdHex` accepts `{ "account": "<funding wallet>" }` and either `amount=<decimal SOL>` or `mint=<classic SPL mint>&rawAmount=<integer base units>`. Amounts use integer arithmetic, reject ambiguous/duplicate parameters and preserve exact u64 token amounts. The service derives every source/destination address itself.

Before returning a transaction it:

1. Requires cached readiness and verifies the approved chain again.
2. Fetches the pocket, mint and canonical token accounts in one confirmed contextual snapshot (only the pocket for a native SOL deposit).
3. Fully decodes the current PocketV3 layout, program owner, app ID and derived address; prefunded system addresses and truncated/unsupported pockets are refused.
4. For tokens, requires an initialized classic SPL mint and a matching initialized, unfrozen source account with enough units. An existing destination must match the pocket/mint, be unfrozen, have no delegate and have no outside close authority. A missing or empty system-owned canonical destination can be created idempotently. Token-2022 is refused.
5. Obtains a blockhash at least as recent as the account context and rechecks freshness before returning unsigned bytes. A process-wide context floor prevents concurrent requests from accepting older evidence after newer evidence was observed.

Native SOL returns one system transfer to the pocket. Token deposits return only canonical ATA creation and the exact SPL transfer from the funding wallet. Native SOL surplus can be recovered home, but is not automatically wrapped and is not a token-account swap leg. Token mint/freeze authorities and liquidity remain separate asset risks; passing a layout check does not approve an asset for trading.

State can change between construction and wallet execution. Clients must independently verify the expected chain, pocket, asset, amount and actual instructions, then simulate before signing. A trusted metadata destination alone does not establish transaction integrity; `verifyFunding` currently checks metadata only. Deposit building is not idempotent settlement: after a lost submission reply, reconcile the original signed transaction before approving another deposit. This service cannot determine whether a wallet submitted its earlier unsigned response.

## Readiness and operations

`GET /health` is diagnostic liveness. `GET /ready` returns 200 only when cached chain, freshness, progress, admission and capacity checks pass, otherwise 503. HTTP health/metadata polls do not trigger RPC calls. A background probe runs every two seconds, requires two advancing confirmed head samples, expires evidence after ten seconds and refuses a head that has not advanced within fifteen seconds. A probe times out after seven seconds; a still-running transport retains its probe slot until settlement, and late success cannot restore readiness.

The shared HTTP router bounds bodies, active handlers and connections. Deposit preparation has its own concurrency limit plus a 30-per-minute IP quota. These are per-process controls, not a distributed quota or a throughput guarantee. GET metadata remains available during refusal, with `disabled: true`.

The private `/metrics` listener exposes fixed readiness labels, active/accepted/rejected/completed preparation counts and bounded provider indices. It includes no wallet/pocket identifiers, signatures, URLs, tokens or key paths. Completion means the handler finished; it does not mean a deposit settled. Configure actual monitoring and alerts separately.

SIGINT/SIGTERM closes new admission and periodic probing, then waits for admitted work (even if its HTTP client disconnected) and the active probe before closing RPC. A forced exit follows after 30 seconds. No signed packet or funds are held by this service.

## Verification and remaining acceptance

Focused tests cover wrong-chain labels, missing/public deployment refusal, metadata origin validation, full pocket/mint/token account checks, canonical unsigned instructions, amount ambiguity, stale and concurrent regressing contexts, opaque protocol errors, stalled/late probes, overload, cached readiness and private metrics. Real compiled services exercise wrong-chain startup, fallback, outage refusal and recovery. The Unix process drill disconnects a request during its account read, sends SIGTERM and verifies preparation completes before RPC closes.

```sh
pnpm --filter @ghostlink/actions test
node services/actions/test/shutdown-drill.mjs # Linux/WSL, after build
SERVICE_RPC_DRILL=1 ACTIONS_DRILL=1 bash scripts/localnet-e2e.sh
```

The validator drill signs deposits with a disposable wallet, checks exact native SOL credit, completes a token swap and verifies exact surplus/closed-account-rent recovery home. It also exercises real RPC failover and ingestion recovery. These results do not certify actual Blink wallet clients, device behavior, hosted provider capacity, deployed binaries, installed alerts or mainnet readiness. See the [release gates](MAINNET-READINESS.md).
