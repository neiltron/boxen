#!/bin/bash
# Stop the pi-durable-sessions celld node. Usage: ./stop.sh [rustfs]
pkill -f "pid-celld-supervisor"  # first, or it restarts celld
pkill -f "celld-0.6.2 --bucket s3://pid-cells" && echo "celld stopped"
[[ "${1:-}" == rustfs ]] && pkill -f "rustfs server" && echo "rustfs stopped"
exit 0
