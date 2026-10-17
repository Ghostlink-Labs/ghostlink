# Owner recovery destinations

The PocketV3 localnet candidate returns funds only to the saved on-chain recovery home. An owner proof remains usable after losing or revoking a bot session. Read the current owner action nonce before proving; successful administrative actions consume it. The private owner interface revokes first, then explicitly approves each recovery batch. Existing deployed V1 programs are separate.

## Token accounts

A wallet's associated token address is a convention, not proof of current ownership. Classic SPL `SetAuthority` can change the account owner. A home token account may also be frozen or carry an external delegate/close authority. Hard-coding its associated address can prevent withdrawal or expose returned assets to old permissions.

For `POST /owner-action` with `action: "sweep"`, send the confirmed `home` and token pairs containing `source` and optional `mint`. **Omit `destination` to request automatic home recovery.** The relayer reads confirmed Pocket/source/destination accounts with a monotonic slot floor, checks the source owner/mint and exact recovery home, then:

1. Reuses the home's associated account when it is initialized, unfrozen, has no delegate, and has no close authority outside the home.
2. Creates the associated account if absent, including a prefunded empty system account.
3. Otherwise creates a fresh auxiliary classic SPL account owned by the same home. Creation, initialization and the proof-authorized sweep are atomic in one transaction. The new address's temporary creation signer is not the token owner or close authority. The home can control the account without that signer.

Sources of the same mint share one automatically selected destination in a batch. A provided `destination` is never silently replaced: it must satisfy the same authority checks, or be the missing canonical account that can be created. A source whose owner, mint or state is invalid is refused. Frozen source accounts and Token-2022 remain unsupported.

The program independently enforces destination ownership/mint, no delegate and no external close authority. The relayer cannot bypass those checks. Sources with an external close authority can still return their complete balance; their empty account/rent may remain. The relayer charges actual quoted transaction fees plus required account rent within its spend budget. A failure before submission does not spend that rent.

Use batches of up to two source accounts: two fresh destinations plus the proof and signatures have been tested within Solana's packet limit. The endpoint's admission limit is 16 pairs, but larger packets are not guaranteed to fit. No lookup table is required for the tested two-account batch.

## Confirmation and retries

A successful response includes `signature` and resolved `tokenPairs: [{source,destination,mint}]`. These are public addresses, not authorization. Verify the consumed owner action nonce, unchanged home, complete source withdrawal and destination ownership/balances on the confirmed chain. Native SOL above Pocket rent is returned as part of the same sweep.

After a lost response, check that same action's outcome. Query home-owned token accounts to find an auxiliary destination if needed; it may differ from the canonical associated address. Do not automatically produce another owner proof because an HTTP response was lost. The consumed nonce prevents replay from creating another account or withdrawing again. A new deliberate recovery step requires fresh chain state and a new proof.

## Reproduction

Build the current programs and services, then run the disposable-validator harness:

```sh
RECOVERY_DESTINATION_DRILL=1 bash scripts/localnet-e2e.sh
```

The drill performs real SPL owner, delegate and close-authority changes. It reproduces refusal of a reassigned canonical destination, recovers two same-mint sources into one clean home-owned account, refuses replay, and atomically recovers two more mints while avoiding their external destination authorities. Compiled-program regressions separately reject unsafe destinations and preserve the source balances/nonce on failure. These are local-validator tests, not public-network deployment or independent security review.

Reference: [SPL Token processor authority and account rules](https://github.com/solana-program/token/blob/main/program/src/processor.rs).
