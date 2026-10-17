# Off-chain services

GhostLink's reference services connect clients to the Solana programs. They carry availability, privacy, transaction-construction and operational responsibilities. On-chain checks do not make a service trustworthy in every respect, and reconstructing chain events does not reconstruct every off-chain request, notification acknowledgment or spending reservation.

## Choose the correct version

The default branch is the published V1 development baseline. The [V2 authorization / PocketV3 candidate](https://github.com/Ghostlink-Labs/ghostlink/tree/codex/mainnet-sdk-foundation/services) contains newer durable-state, recovery and hosted-service controls. It is localnet-only and is not a drop-in upgrade for the preserved devnet deployment. Neither version is approved for real funds.

| Service | Responsibility | Boundary to understand |
| --- | --- | --- |
| [Indexer](indexer/) | Rebuild trees and serve witness data/activity | Clients must verify roots against trusted chain state. Requests can reveal metadata; archival completeness is a separate requirement. |
| [Relayer](relayer/) | Submit supported operations and pay fees | Durable request identity, fee/rent accounting, authorization and uncertain outcomes matter. It must not receive the owner's identity secret. |
| [Solver](solver/) | Construct and submit supported atomic fills | Validate session authority, route instructions, fees and actual outcomes. A new route is not automatically safe or compatible. |
| [Actions](actions/) | Construct funding transactions | The funding wallet/client must independently validate destination, amount, instructions and total debit before signing. |
| [Watcher](watcher/) | Observe events, deliver alerts and optionally fund cranks | Delivery can be repeated; receivers need deduplication. Observation and fee history must survive restart. |
| [Shared](shared/) | Encodings, event decoding and transport helpers | Clients, programs and deployed account formats must agree. |
| [E2E](e2e/) | Disposable local-validator integration flow | Test fixtures do not certify production providers or real devices. |

## Development and operations

For the baseline, use the checked-in [setup guide](../docs/SETUP.md), [devnet notes](../docs/DEVNET.md) and version-matched service entry points. Older JSON/ephemeral state paths are development behavior, not a production recovery strategy.

For the candidate, read its dedicated operations guides before configuring a hosted process:

- [Indexer](https://github.com/Ghostlink-Labs/ghostlink/blob/codex/mainnet-sdk-foundation/docs/INDEXER-OPERATIONS.md)
- [Relayer](https://github.com/Ghostlink-Labs/ghostlink/blob/codex/mainnet-sdk-foundation/docs/RELAYER-OPERATIONS.md)
- [Solver](https://github.com/Ghostlink-Labs/ghostlink/blob/codex/mainnet-sdk-foundation/docs/SOLVER-OPERATIONS.md)
- [Watcher](https://github.com/Ghostlink-Labs/ghostlink/blob/codex/mainnet-sdk-foundation/docs/WATCHER-OPERATIONS.md)
- [Actions](https://github.com/Ghostlink-Labs/ghostlink/blob/codex/mainnet-sdk-foundation/docs/ACTIONS-OPERATIONS.md)
- [RPC](https://github.com/Ghostlink-Labs/ghostlink/blob/codex/mainnet-sdk-foundation/docs/RPC-OPERATIONS.md) and [backup/restore](https://github.com/Ghostlink-Labs/ghostlink/blob/codex/mainnet-sdk-foundation/docs/BACKUP-RESTORE.md)

Do not delete or replace production state to bypass a startup error. Keep credentials, keys, databases, WAL files and backups outside source control, and independently reconcile uncertain history before resuming work. Candidate services have service-specific existing-state/identity requirements, restore restrictions, readiness and shutdown behavior; read each guide rather than applying one generic environment configuration.

See the [project README](../README.md#versions-and-release-status) for version boundaries and the [candidate readiness plan](https://github.com/Ghostlink-Labs/ghostlink/blob/codex/mainnet-sdk-foundation/docs/MAINNET-READINESS.md) for outstanding release gates.
