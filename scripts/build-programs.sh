#!/usr/bin/env bash
# Build every binary used by the local validator and LiteSVM tests.
set -euo pipefail
cd "$(dirname "$0")/.."
for program in registry census pocket cpi-caller; do
  cargo-build-sbf --manifest-path "programs/$program/Cargo.toml" \
    --tools-version "${PLATFORM_TOOLS:-v1.52}"
done
