#!/usr/bin/env bash
# Compiles both circuits, makes THROWAWAY dev proving keys, proves the
# fixture inputs once end-to-end, and regenerates the Rust verifying keys.
#
# Dev keys only: a real deployment uses the perpetual Powers of Tau and a
# public phase-2 ceremony (build plan, section 5). Nothing this script
# produces may ever reach mainnet.
#
# Run from the repo root on Linux/WSL: scripts/build-circuits.sh
set -euo pipefail

cd "$(dirname "$0")/.."
BUILD=circuits/build
PTAU="$BUILD/pot15_final.ptau"
SNARKJS="node circuits/node_modules/snarkjs/cli.js"
if [ ! -f circuits/node_modules/snarkjs/cli.js ]; then
  echo "Missing pinned snarkjs installation; run pnpm install --frozen-lockfile first" >&2
  exit 1
fi

mkdir -p "$BUILD" circuits/keys

echo "== compiling circuits =="
for c in login owner; do
  circom "circuits/$c.circom" --r1cs --wasm --sym -o "$BUILD" -l circuits/node_modules
done
$SNARKJS r1cs info "$BUILD/login.r1cs"
$SNARKJS r1cs info "$BUILD/owner.r1cs"

if [ ! -f "$PTAU" ]; then
  echo "== generating local powers of tau (dev only) =="
  $SNARKJS powersoftau new bn128 15 "$BUILD/pot15_0000.ptau" -v >/dev/null
  $SNARKJS powersoftau contribute "$BUILD/pot15_0000.ptau" "$BUILD/pot15_0001.ptau" \
    --name="ghostlink dev" -e="ghostlink dev entropy, throwaway" -v >/dev/null
  $SNARKJS powersoftau prepare phase2 "$BUILD/pot15_0001.ptau" "$PTAU" -v >/dev/null
  rm -f "$BUILD/pot15_0000.ptau" "$BUILD/pot15_0001.ptau"
fi

echo "== groth16 setup (throwaway phase 2) =="
for c in login owner; do
  $SNARKJS groth16 setup "$BUILD/$c.r1cs" "$PTAU" "$BUILD/${c}_dev.zkey" >/dev/null
  $SNARKJS zkey export verificationkey "$BUILD/${c}_dev.zkey" "circuits/keys/${c}_vk.json"
done

# Server verification must use the same key as the generated prover and
# the Rust verifier. A throwaway setup changes all three together.
cp circuits/keys/login_vk.json packages/verify/keys/login_vk.json

echo "== proving fixture inputs end-to-end =="
node circuits/scripts/prove-fixtures.mjs

echo "== regenerating Rust verifying keys =="
if command -v cargo >/dev/null 2>&1 && [ -f programs/verifier/Cargo.toml ]; then
  cargo run --quiet -p ghostlink-verifier --bin gen-vk --features circom-vk
else
  echo "verifier crate not present yet; skipping vk.rs generation"
fi

echo "done."
