# On-chain programs

Three small Anchor programs — each readable in one sitting — plus a shared verification library. In plain language: the **registry** is the one-time guestbook a wallet signs into (one signature, ever); the **census** writes down "this wallet held this much at this moment" so balances can be proved later without naming the wallet; and the **pocket** is the per-app spending account whose rules no app can talk its way around — atomic fills, an oracle-checked price floor, a daily cap, and a single exit that always points home.

| Crate | What it is |
| --- | --- |
| [`verifier/`](verifier) | Library linked into the programs: Groth16 verification (compiled-in keys), Poseidon values, Merkle frontier + root ring, intent bytes. No program of its own, so there is no cross-program trust boundary around proof checks. |
| [`registry/`](registry) | `initialize`, `register`. No update, no delete, no admin. A wallet that wants a new secret uses a new wallet. |
| [`census/`](census) | `initialize`, `snapshot` — permissionless, reads only token-program-owned accounts, so a snapshot can never lie. |
| [`pocket/`](pocket) | `open_session`, `fill_begin`/`fill_end`, `sweep_home`, `propose/execute/cancel_change`, `revoke_session`. |
| [`itests/`](itests) | LiteSVM integration tests: the compiled binaries running every flow and every refusal in the threat model. Deliberately rebuilds all instructions from raw bytes so cross-stack drift fails loudly. |

## Building and testing

```bash
scripts/build-circuits.sh    # once: circuit keys the verifier compiles in
for p in registry census pocket; do
  cargo-build-sbf --manifest-path programs/$p/Cargo.toml --tools-version v1.52
done
cargo test --workspace       # vectors, proof cross-checks, LiteSVM flows
```

## Invariants under audit (build plan §6)

- Only `fill_begin` moves tokens to a non-home address, and it cannot commit without a matching `fill_end` in the same transaction.
- Every `invoke_signed` with the pocket PDA lives in `pocket/src/token.rs` and is an SPL Token Transfer or CloseAccount the pocket issues itself.
- `open_session` never changes the home or policy of an existing pocket.
- Every proof is bound to a domain and a session commitment or action hash; every root checks against a 128-root ring.
- Upgrade authority is removed after audit sign-off; a v2 is a new program and users migrate by sweeping home.
