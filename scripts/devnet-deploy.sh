#!/usr/bin/env bash
# Deploys the three programs to devnet and runs the identity-path e2e
# against them. Devnet only — mainnet follows the M3/M4 process in the
# build plan (audits, ceremony, founder sign-off) and is NOT this script.
#
# Needs (Linux/WSL):
#   ~/.ghostlink/keys/{registry,census,pocket}.json   program ids
#   ~/.ghostlink/keys/deployer.json                   funded with ~7 SOL
#   program .so files (cargo-build-sbf --tools-version v1.52)
#   pnpm -r build
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS="${GHOSTLINK_PROGRAM_KEY_DIR:-$HOME/.ghostlink/keys}"
DEPLOY_DIR="${CARGO_TARGET_DIR:-target}/deploy"
URL="${DEVNET_RPC:-https://api.devnet.solana.com}"
DEPLOYER="${GHOSTLINK_DEPLOYER_KEYPAIR:-$KEYS/deployer.json}"

GENESIS="$(solana genesis-hash -u "$URL")"
if [ "$GENESIS" != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" ]; then
  echo "Refusing deployment: RPC is not Solana devnet" >&2
  exit 1
fi

echo "deployer: $(solana-keygen pubkey "$DEPLOYER") ($(solana balance -k "$DEPLOYER" -u "$URL"))"

for p in registry census pocket; do
  ID=$(solana-keygen pubkey "$KEYS/$p.json")
  if solana program show "$ID" -u "$URL" >/dev/null 2>&1; then
    echo "$p already deployed at $ID"
    continue
  fi
  echo "== deploying $p ($ID) =="
  solana program deploy "$DEPLOY_DIR/ghostlink_$p.so" \
    --program-id "$KEYS/$p.json" \
    --keypair "$DEPLOYER" \
    -u "$URL" \
    --commitment confirmed
done

echo "== identity-path e2e against devnet =="
REPO_ROOT="$(pwd)" RPC_URL="$URL" PAYER_KEYPAIR="$DEPLOYER" SKIP_FILL=1 \
  node services/e2e/dist/run.js
