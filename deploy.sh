#!/bin/bash
# Deploy apps/worker/src/ to the running node. celld 0.6.1 adopts a new version on its
# next pointer poll (~15s) without a restart, so cells' sandboxes keep their
# disks and in-flight sign-ins survive. Restart only if adoption stalls:
#   ./stop.sh && ./start.sh
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
pnpm run deploy 2>&1 | grep -E "Version ID|rror" || true
echo "deployed; the node adopts it within ~15s"
