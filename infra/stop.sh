#!/bin/bash
# Stop the boxen celld node (and optionally rustfs). Usage: pnpm stop [rustfs]
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  ""|rustfs) ;;
  -h|--help)
    echo "Usage: pnpm stop [rustfs]"
    exit 0
    ;;
  *)
    echo "Usage: pnpm stop [rustfs]" >&2
    exit 2
    ;;
esac

stopped_supervisor=0
if pkill -f "boxen-celld-supervisor" 2>/dev/null; then
  stopped_supervisor=1
fi

if pkill -f "celld-0.6.2 --bucket s3://" 2>/dev/null; then
  echo "celld stopped"
elif [[ "$stopped_supervisor" -eq 1 ]]; then
  echo "celld supervisor stopped (celld was not running)"
else
  echo "celld was not running"
fi

if [[ "${1:-}" == "rustfs" ]]; then
  # Only this checkout's rustfs, not one another checkout started.
  if pkill -f "rustfs server .*$PWD/.data/rustfs" 2>/dev/null; then
    echo "rustfs stopped"
  else
    echo "rustfs was not running"
  fi
fi
