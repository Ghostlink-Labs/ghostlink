#!/usr/bin/env bash
# Full Pocket/bot/solver journey with locally supplied, hash-checked Jupiter/Raydium snapshots.
# No mainnet transactions or provider requests. See docs/JUPITER-ROUTING.md.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$#" -eq 1 ] || { echo "usage: scripts/jupiter-localnet-e2e.sh snapshot-directory" >&2; exit 1; }
[ -z "${PAYER_KEYPAIR:-}" ] || { echo "funded payer keys are not accepted" >&2; exit 1; }
DEPLOY_DIR="${CARGO_TARGET_DIR:-target}/deploy"
FIXTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ghostlink-jupiter.XXXXXX")"
if solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1; then
  echo "RPC port 8899 is already occupied; refusing to attach to an existing validator" >&2
  exit 1
fi
for so in ghostlink_registry ghostlink_census ghostlink_pocket; do
  [ -f "$DEPLOY_DIR/$so.so" ] || { echo "missing $DEPLOY_DIR/$so.so" >&2; exit 1; }
done
node services/e2e/dist/jupiter-fixture.js "$1" "$FIXTURE_DIR"
mapfile -d '' -t PROGRAM_FIELDS < <(node --input-type=module -e '
  import fs from "node:fs";
  for (const p of JSON.parse(fs.readFileSync(process.argv[1], "utf8")).programs) process.stdout.write(p.id + "\0" + p.file + "\0");
' "$FIXTURE_DIR/fixture.json")
[ "${#PROGRAM_FIELDS[@]}" -eq 4 ] || { echo "missing DEX program manifest" >&2; exit 1; }
DEX_ARGS=()
for ((i=0; i<4; i+=2)); do DEX_ARGS+=(--bpf-program "${PROGRAM_FIELDS[$i]}" "${PROGRAM_FIELDS[$((i+1))]}"); done
echo "Disposable Jupiter/Pocket ledger: $FIXTURE_DIR/ledger"
solana-test-validator --reset --quiet --bind-address 127.0.0.1 --ledger "$FIXTURE_DIR/ledger" \
  --bpf-program 54EZ5ZkUANBs1SfQoXaU5EQSR8VAaD3XDtKEZGp6KjRv "$DEPLOY_DIR/ghostlink_registry.so" \
  --bpf-program CvRA16GAa5ynUE3bzgMWuPYTbHLsdvyBydJoZVft5x9d "$DEPLOY_DIR/ghostlink_census.so" \
  --bpf-program HbSux9YnTupzNiRUwdR2mjTpJJryx25RV42wry4kCwiH "$DEPLOY_DIR/ghostlink_pocket.so" \
  "${DEX_ARGS[@]}" --account-dir "$FIXTURE_DIR/accounts" &
VALIDATOR_PID=$!
trap 'kill "$VALIDATOR_PID" 2>/dev/null || true; wait "$VALIDATOR_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  kill -0 "$VALIDATOR_PID" 2>/dev/null || { echo "validator stopped during startup" >&2; exit 1; }
  if solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1; then break; fi
  sleep 1
done
solana cluster-version -u http://127.0.0.1:8899 >/dev/null
REPO_ROOT="$(pwd)" RPC_URL=http://127.0.0.1:8899 JUPITER_FIXTURE_DIR="$FIXTURE_DIR" node services/e2e/dist/run.js
