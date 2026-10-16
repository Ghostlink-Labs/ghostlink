# GhostLink service kit

Shared protocol encoders, account readers, token helpers and HTTP primitives for the experimental GhostLink services and Node bot package. Low-level helpers do not establish deployment trust or production readiness. The optional expected program passed to account readers must come from trusted deployment configuration.

This companion library is packed with `pnpm pack:bot`; a registry release is not implied. Its archive contains compiled code, declarations and license only. See the [bot backend guide](../../packages/bot/README.md) for installing the reviewed companion archives and their dependency overrides.

The optional `@ghostlink/service-kit/storage` subpath provides Node-only encrypted SQLite storage shared by bot consent and solver journals. It requires Node 22.13+ within the 22 release line, or Node 24. SQLite transaction callbacks must be synchronous. It is not exported from the general entry point and must never enter a browser bundle.
