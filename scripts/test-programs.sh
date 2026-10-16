#!/usr/bin/env bash
# Uses the committed public fixtures; no setup or key regeneration.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo test --workspace --exclude ghostlink-itests
cargo test -p ghostlink-itests
