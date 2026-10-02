#!/bin/bash
# Deploy src/ and restart the node (waits out the old node's drain).
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
npm run deploy 2>&1 | grep -E "Version ID|rror" || true
./stop.sh >/dev/null
while pgrep -f "celld-0.6.1 --bucket s3://pid-cells" >/dev/null; do sleep 0.5; done
./start.sh | grep -v "^$"
