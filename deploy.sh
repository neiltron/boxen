#!/bin/bash
# Deploy apps/worker/src/ to the running node. celld 0.6.2 adopts a new version on its
# next pointer poll (~15s) without a restart, so cells' sandboxes keep their
# disks and in-flight sign-ins survive. Restart only if adoption stalls:
#   ./stop.sh && ./start.sh
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH (requires Node >=24.5.0 <25)" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm not found on PATH" >&2; exit 1; }

pnpm run deploy

echo
echo "deployment submitted to local RustFS (s3://pid-cells)."
echo "  hot-adoption: running celld picks up the new version on its next pointer poll (~15s)"
echo "                without restarting containers (sandboxes keep their disks)."
echo "  note:         adoption is not verified here — check .celld.log if changes don't appear,"
echo "                or restart with ./stop.sh && ./start.sh if adoption stalls."
