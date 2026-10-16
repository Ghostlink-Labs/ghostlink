# Trading bot integration research

Reviewed 2026-10-16 using the providers' own websites and documentation. This is an implementation shortlist, not a partnership announcement or a claim that these services already accept GhostLink pockets. “Mastro” is interpreted as Maestro; “Soul trading bots” likely means SOL Trading Bot/STBOT.

## Findings

| Provider | Documented interface | GhostLink integration decision |
| --- | --- | --- |
| [Maestro](https://docs.maestrobots.com/sniper/wallet-setup) | Its onboarding generates or imports trading wallets. | Operator integration is needed for native pocket execution. No public external-signer or Pocket adapter was found in the reviewed docs. Importing an owner key is not an integration strategy. |
| [Cove](https://docs.cove.trade/builders/mcp-tools) | A documented MCP interface supports scoped bearer tokens, OAuth, trading, order status and idempotency. Profile tokens can restrict wallets; global tokens have broader reach. Access is enabled per account. | Strong candidate for an automation partnership. These tools act on Cove account wallets; they do not establish support for a GhostLink PDA. Use narrowly scoped profile permissions if a separately approved evaluation proceeds. |
| [SOL Trading Bot / STBOT](https://soltradingbot.gitbook.io/docs) | Trading, sniping, copy trading and conditional/DCA orders are documented. | Candidate operator integration. No public external-signer/Pocket contract was established from the accessible documentation. Community repositories with similar names are not verified official SDKs. |
| [Trojan](https://docs.trojanonsolana.com/overview/quick-start-guide) | The Telegram quick start funds a bot-associated wallet and configures trading. | Requires a provider-supported adapter for pocket execution. A Telegram command or token link does not replace the wallet authorization model. |
| [BONKbot / Telemetry](https://docs.bonkbot.io/) | Telegram and terminal trading, passkey security and automated orders are documented. | Provider security and passkey support do not imply compatibility with GhostLink's passkey proof or constrained account. An explicit execution adapter remains unverified. |
| [Banana Gun / Banana Pro](https://bananagun.io/) | Telegram and web trading; generated/imported wallets; sniping, copy trading, DCA and limits. | Candidate operator integration. No public external-signer/Pocket interface was found in the reviewed documentation. Multichain support does not make GhostLink multichain. |
| [GMGN trading API](https://docs.gmgn.ai/index/cooperation-api-integrate-gmgn-solana-trading-api) | Approved API access can return an unsigned Solana transaction for a supplied wallet address, followed by submission/status APIs. | Evaluate as a route source only after validating instructions, authorities, destinations, fees and lookup tables. An assembled wallet transaction is not automatically composable with GhostLink's atomic fill. Confirm access and capacity with the provider. |
| [Jupiter Router](https://dev.jup.ag/docs/swap) | The Router build endpoint supplies composable swap instructions; other routing paths can return transactions with different composition restrictions. | First execution integration to implement. A solver receives the bounded input, performs the reviewed swap, and delivers output to the pocket within the same transaction. API credentials, simulation and strict route validation are required. |

The absence of a documented adapter in this review is not proof that a provider has no private integration program. No provider has been contacted or tested with GhostLink funds. Marketing speed claims were not used as acceptance evidence.

## Implementation priorities

The localnet candidate now includes [`@ghostlink/bot`](../packages/bot/README.md): Telegram authentication, encrypted persistent session keys, idempotent consent requests, confirmed permission checks and a bot-signed reference fill. Its full local-validator test uses synthetic Telegram authentication and an inventory route. No named provider, real Telegram device, Jupiter route or mainnet deployment is validated by that test. Trade nonce/submission durability remains to be implemented.

1. Ship a generic Node.js reference bot and Telegram Mini App onboarding contract. Owners approve a public bot key, exact policy, recovery wallet and expiry in a trusted local proving context. The bot never receives the owner's wallet key or identity secret.
2. Implement Jupiter composition for a small classic-SPL asset set, with both buy and sell tests, quote expiry, bounded fees, transaction simulation and chain-confirmed reconciliation.
3. Treat Cove's documented automation interface and GMGN's route API as separate evaluations. Neither should be advertised as a GhostLink account integration until a native constrained-account flow is demonstrated.
4. Prepare the same adapter contract for Maestro, STBOT, Trojan, BONKbot and Banana Gun. Their operators must adopt it or expose an equivalent supported execution interface. End users cannot install our SDK inside a third-party hosted bot.
5. Add launchpad sniping only after a versioned policy supports bounded oracle-less buys **and exits**. Current oracle rules do not support arbitrary new-token round trips for unattended software sessions.

## Acceptance contract for every integration

- Authenticate the user/request and bind a single-use consent request to the bot key, origin, deployment, policy, home and expiry. Validate [Telegram Mini App data](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) on the backend; Telegram authentication alone grants no wallet authority.
- Verify the confirmed on-chain session and policy before spending. Support explicit expiry, rotation and revocation. Isolate concurrent bots instead of silently replacing another bot's session.
- Sign only canonical intents with exact input caps, output floors, nonces and deadlines. Refuse arbitrary transaction signing and unsupported token extensions/actions.
- Persist idempotency and nonce reservations across crashes; reconcile confirmed, failed, expired and unknown submissions before retrying. Test revoked sessions, stale quotes, depleted fee budgets and provider outages.
- Keep begin/swap/end in one transaction. [Jito transport](https://docs.jito.wtf/lowlatencytxnsend/) may help submission, but separate bundle transactions do not satisfy the protocol's atomic fill rule.
- Demonstrate funding, buy, sell, cancellation, recovery and withdrawal to the approved home. Publish the tested network, token set, runtime and supported operation matrix.

Website login and token-gated access remain separate integrations: sites verify a proof plus a fresh signed challenge. An ordinary Connect Wallet flow cannot treat a pocket PDA as an Ed25519 wallet. See [the broader use-case matrix and release gates](MAINNET-READINESS.md).
