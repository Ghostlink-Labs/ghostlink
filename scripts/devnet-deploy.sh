#!/usr/bin/env bash
# V2 changes the login proof and session instruction. The historical V1
# deployment workflow is available in Git history, not applicable here.
set -euo pipefail
echo "V2 has no verified devnet deployment. Refusing to use the preserved V1 program IDs." >&2
echo "Use scripts/localnet-e2e.sh. A fresh deployment manifest and reviewed migration are required; see docs/adr/0003-session-authorization-v2.md." >&2
exit 1
