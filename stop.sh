#!/bin/bash
# Stop the boxen celld node (and optionally rustfs). Usage: ./stop.sh [rustfs]
set -euo pipefail

case "${1:-}" in
  ""|rustfs) ;;
  -h|--help)
    echo "Usage: ./stop.sh [rustfs]"
    exit 0
    ;;
  *)
    echo "Usage: ./stop.sh [rustfs]" >&2
    exit 2
    ;;
esac

stopped_supervisor=0
if pkill -f "boxen-celld-supervisor" 2>/dev/null; then
  stopped_supervisor=1
fi

if pkill -f "celld-0.6.2 --bucket s3://pid-cells" 2>/dev/null; then
  echo "celld stopped"
elif [[ "$stopped_supervisor" -eq 1 ]]; then
  echo "celld supervisor stopped (celld was not running)"
else
  echo "celld was not running"
fi

if [[ "${1:-}" == "rustfs" ]]; then
  if pkill -f "rustfs server" 2>/dev/null; then
    echo "rustfs stopped"
  else
    echo "rustfs was not running"
  fi
fi
