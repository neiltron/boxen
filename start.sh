#!/bin/bash
# Launch pi-durable-sessions: rustfs (shared, :9000) → celld 0.6.1 node (:8093).
# Needs a Docker daemon for the per-session Sandbox containers.
# UI is separate: npm run ui (http://localhost:5176), then sign in from the sidebar.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

wait_port() {
  for _ in $(seq 1 30); do
    nc -z 127.0.0.1 "$1" 2>/dev/null && return 0
    sleep 0.3
  done
  echo "timed out waiting for port $1" >&2; exit 1
}

docker info >/dev/null 2>&1 || { echo "no Docker daemon (try: orbctl start)" >&2; exit 1; }

if ! nc -z 127.0.0.1 9000 2>/dev/null; then
  RUSTFS_ACCESS_KEY=swarmadmin RUSTFS_SECRET_KEY=swarmsecret \
    rustfs server --address 127.0.0.1:9000 ../.rustfs-data >> ../.rustfs.log 2>&1 &
  echo "rustfs starting (pid $!)"
fi
wait_port 9000

if ! nc -z 127.0.0.1 8093 2>/dev/null; then
  CELLD_TTL_MS=30000 \
  AWS_ACCESS_KEY_ID=swarmadmin AWS_SECRET_ACCESS_KEY=swarmsecret \
    celld-0.6.1 --bucket s3://pid-cells --endpoint http://127.0.0.1:9000 \
    --listen 127.0.0.1:8093 >> .celld.log 2>&1 &
  echo "celld starting (pid $!)"
fi
wait_port 8093


echo
echo "pi-durable-sessions is up:"
echo "  api    http://127.0.0.1:8093/api/sessions"
echo "  ui     npm run ui   →  http://localhost:5176"
echo "  (after editing src/: npm run deploy, then ./stop.sh && ./start.sh)"
