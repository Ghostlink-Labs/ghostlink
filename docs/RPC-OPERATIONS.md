# RPC failover for bot and solver operations

The solver adds cached readiness, an authenticated journal write probe, bounded admission, private provider metrics and graceful draining around this transport. See [solver operations](SOLVER-OPERATIONS.md).

`@ghostlink/service-kit/rpc` provides a Node-only `createRpcPool` factory. The solver entry point uses it for authorization reads, route preparation, simulation, fee checks, signed sends and confirmation. It accepts one to four **operator-approved** endpoints and an independently approved genesis hash. Never accept an endpoint or expected genesis from a trade request or Telegram user. Existing candidate public-chain guards still apply.

Set `RPC_ENDPOINTS_PATH` to a private JSON file outside the repository. It overrides `RPC_URL`; without it, the solver uses the existing single URL. The file is bounded to 16 KiB and has this shape:

```json
[
  { "url": "https://primary.example.invalid/", "headers": { "authorization": "Bearer REPLACE_LOCALLY" } },
  { "url": "https://secondary.example.invalid/", "headers": { "x-api-key": "REPLACE_LOCALLY" } }
]
```

Endpoints require HTTPS except for loopback HTTP in local tests. URL query credentials and authorization/custom `x-*` headers are supported; userinfo, fragments, redirects and other custom headers are refused. Store the file in the operator's secret system with restrictive permissions. Do not print it or commit it. Provider error text/data is replaced with a generic message and its numeric code. Health reports identify providers by array index. Successful RPC results, including simulation logs, are still provider data; do not expose arbitrary raw RPC responses as a public diagnostic API.

For a Node bot, inject the connection wherever its existing `BotOnboarding` setup accepts `chain`:

```ts
import { createRpcPool } from "@ghostlink/service-kit/rpc";

const rpc = createRpcPool({ genesisHash: approvedGenesis, endpoints: privateOperatorEndpoints });
// Existing BotOnboarding options: chain: rpc.connection
// Preserve the same durable BotKeyStore and business request keys on retry.
// Inspect rpc.status() from private monitoring; rpc.close() cancels pending work.
```

Use the same supported Node versions as the bot's SQLite store. This subpath is not exported from the browser-facing entry point. The companion archive is included in `pnpm pack:bot`; no registry publication is implied.

## Retry and confirmation contract

Each request checks the chosen endpoint's genesis before sending business RPC. A mismatch quarantines that endpoint until the pool is recreated after operator investigation. This checks trusted provider configuration; it is not a cryptographic defense against a dishonest provider. The pool copies the serialized request once and retries it unchanged on transport/HTTP failures, malformed or oversized responses, stale context, node-unhealthy or minimum-context errors. Semantic JSON-RPC errors, including preflight failure, are returned without replay across every provider.

The only supported write RPC is `sendTransaction`, used by web3's signed send methods. Failover resends identical signed transaction bytes and options. It never changes the blockhash or prepares/signs a replacement. The solver sets `maxRetries: 0`, persists the packet before send, verifies the returned signature and reconciles the original signature through its [transaction journal](TRANSACTION-RECOVERY.md). A lost response, timeout or pool outage leaves the outcome uncertain. A send acknowledgment does not establish settlement.

Default bounds are 1.5 seconds per provider including its genesis probe, 6 seconds per HTTP operation, 4 MiB per response and 64 in-flight operations. Both headers and streamed response bodies are covered by cancellation. Each provider is tried at most once per operation. Failed endpoints enter exponential cooldown from 0.5 to 8 seconds; a working fallback remains preferred until it fails. The pool does not automatically rebalance. When all providers are cooling down, requests fail immediately; callers should retain the original order and retry with bounded backoff. Coordinate application-wide retry/rate budgets separately.

Confirmation polls signature history over the same HTTP pool. No confirmation WebSocket bypasses the approved endpoints. The default deadline is 60 seconds; the solver's shorter confirmation abort signal cancels nested requests. Only the requested commitment or stronger completes confirmation, and an on-chain error remains an error. A confirmation expiration exception alone does **not** prove absence or authorize a replacement trade; the coordinator performs its additional finalized expiry checks. Blockheight strategies and bounded legacy signature polling are supported. Durable-nonce confirmation, batch RPC, airdrops and WebSocket subscriptions are explicitly unsupported. This is a transport for the reviewed bot/solver path, not a universal replacement for all Connection features.

Account/slot context cannot move below the pool's per-commitment observations or an explicit `minContextSlot`. Processed signature-status context never raises a confirmed/finalized authority floor. These in-memory floors do not replace the bot and solver's durable per-pocket floors across restart. Missing historical transaction data is uncertainty, not evidence that a trade never happened.

## Verification and remaining operational gates

HTTP-server tests cover chain mismatch, outage, timeout, rate limiting, malformed/oversized replies, exact-byte replay, stale context, commitment separation, semantic rejection, cancellation, unsupported operations and confirmation failure. The packed bot consumer loads the public subpath and verifies closed-transport behavior.

After building the local programs/circuits and `@ghostlink/e2e` dependencies, run `RPC_FAILOVER_DRILL=1 bash scripts/localnet-e2e.sh`. The disposable validator uses two real HTTP proxies. The primary forwards the solver's signed fill, receives an acceptance and drops the response. The fallback receives the identical request, and signature reconciliation uses the fallback. The existing lost-acknowledgment/process-reopen drill also requires one prepared transaction, confirmed settlement and complete owner recovery. It uses development keys, synthetic Telegram authentication and inventory settlement.

This does not establish hosted-provider capacity, independent failure domains, account consistency under actual provider lag, real Telegram/device acceptance, production alerts or public-chain readiness. Indexer, watcher, relayer, actions and browser connections retain their existing transports. Their availability and subscription recovery need separate integration evidence. Production deployment still requires the [release gates](MAINNET-READINESS.md), provider contract/quotas, monitoring for prolonged cooldown or quarantine, and a rehearsed incident procedure. No public-chain deployment is part of this drill.

Protocol references: [genesis identity](https://solana.com/docs/rpc/http/getgenesishash), [signed submission and acknowledgment](https://solana.com/docs/rpc/http/sendtransaction), [signature history and commitment](https://solana.com/docs/rpc/http/getsignaturestatuses).
