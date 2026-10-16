#!/usr/bin/env bash
# Localnet end-to-end: boots a validator with the three programs and the
# fake oracle accounts at genesis, then runs services/e2e against it.
# Run from the repo root on Linux/WSL after:
#   scripts/build-circuits.sh  (circuit artifacts + dev keys)
#   program .so files in $CARGO_TARGET_DIR/deploy or target/deploy
#   pnpm install && pnpm -r build
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOY_DIR="${CARGO_TARGET_DIR:-target}/deploy"
GENESIS_DIR="services/e2e/.genesis"
LEDGER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ghostlink-ledger.XXXXXX")"

# Never attach the test harness to a validator someone already started.
if solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1; then
  echo "RPC port 8899 already has a validator; stop it before starting this disposable stack" >&2
  exit 1
fi

for so in ghostlink_registry ghostlink_census ghostlink_pocket; do
  [ -f "$DEPLOY_DIR/$so.so" ] || { echo "missing $DEPLOY_DIR/$so.so — build programs first"; exit 1; }
done

echo "== genesis accounts =="
node services/e2e/dist/genesis.js "$GENESIS_DIR"

echo "== starting validator =="
echo "Disposable ledger: $LEDGER_DIR"
solana-test-validator \
  --reset --quiet --ledger "$LEDGER_DIR" \
  --bpf-program 54EZ5ZkUANBs1SfQoXaU5EQSR8VAaD3XDtKEZGp6KjRv "$DEPLOY_DIR/ghostlink_registry.so" \
  --bpf-program CvRA16GAa5ynUE3bzgMWuPYTbHLsdvyBydJoZVft5x9d "$DEPLOY_DIR/ghostlink_census.so" \
  --bpf-program HbSux9YnTupzNiRUwdR2mjTpJJryx25RV42wry4kCwiH "$DEPLOY_DIR/ghostlink_pocket.so" \
  --account-dir "$GENESIS_DIR" \
  &
VALIDATOR_PID=$!
trap 'kill $VALIDATOR_PID 2>/dev/null || true' EXIT

echo "== waiting for validator =="
for i in $(seq 1 60); do
  kill -0 "$VALIDATOR_PID" 2>/dev/null || { echo "validator stopped during startup" >&2; exit 1; }
  if solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
solana cluster-version -u http://127.0.0.1:8899 >/dev/null

echo "== running e2e =="
REPO_ROOT="$(pwd)" RPC_URL=http://127.0.0.1:8899 node services/e2e/dist/run.js
