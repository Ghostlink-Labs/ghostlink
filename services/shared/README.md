# GhostLink service kit

The Node-only `@ghostlink/service-kit/rpc` subpath provides operator-approved HTTP failover with genesis checks, bounded requests, context floors and HTTP signature confirmation. The solver, relayer and RPC-enabled indexer entry points use it; Node bots can inject its connection. Its `loadRpcEndpoints` helper reads a bounded private operator configuration without exposing file/parser diagnostics. See the [RPC operations guide](../../docs/RPC-OPERATIONS.md) for configuration, exact-transaction retry semantics, supported methods and remaining operational gates.

The shared HTTP router keeps unexpected error responses and default logs opaque in every environment. `exposeErrors` and custom `onError` handlers are explicit debugging facilities; hosted applications must not expose raw provider errors, request values or credentials. Caller-authored `HttpError` messages are public API text and must contain only deliberately public information.

Shared protocol encoders, account readers, token helpers and HTTP primitives for the experimental GhostLink services and Node bot package. Low-level helpers do not establish deployment trust or production readiness. The optional expected program passed to account readers must come from trusted deployment configuration.

This companion library is packed with `pnpm pack:bot`; a registry release is not implied. Its archive contains compiled code, declarations and license only. See the [bot backend guide](../../packages/bot/README.md) for installing the reviewed companion archives and their dependency overrides.

The optional `@ghostlink/service-kit/storage` subpath provides Node-only encrypted SQLite storage shared by bot consent and solver journals. It requires Node 22.16+ within the 22 release line, or Node 24. SQLite transaction callbacks must be synchronous. It is not exported from the general entry point and must never enter a browser bundle.

Storage backups use SQLite's backup API and authenticate the complete snapshot. Restores create a new recovery epoch; bot and solver wrappers enforce different authority restrictions before resuming. Follow the [operator runbook](../../docs/BACKUP-RESTORE.md), rather than copying live database files or treating a restore as an ordinary restart.

Planned key rotation authenticates and re-encrypts every declared encrypted column in one write transaction. Complete schema descriptors and metadata bindings must be maintained by the wrapper when its schema changes. Unknown schema is refused; stale key holders fail subsequent API writes. Use the bot/journal `rotateKey` wrappers, provision the replacement secret before migration, and reopen all other workers afterward. Direct use of cached raw SQLite handles is outside these API guarantees.
