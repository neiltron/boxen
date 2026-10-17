#!/bin/bash
# Launch pi-durable-sessions: rustfs (shared, :9000) → celld 0.6.2 node (:8093).
# Needs a Docker daemon for the per-session Sandbox containers.
# UI is separate: pnpm ui (http://localhost:5176), then sign in from the sidebar.
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
  PIDS_CELLD="celld-0.6.2" node ops/celld.mjs --version >/dev/null
  # celld cuts outbound fetches (whole response included) at its default
  # timeout, 120s as observed: long model streams and long sandbox commands
  # (npm install under emulation) died with "error decoding response body".
  # A missed lease renewal (the Mac sleeping) makes celld halt on purpose
  # ("SELF-FENCE" in .celld.log), so a loop restarts it. caffeinate -i holds
  # off idle sleep while it runs; a closed lid still sleeps.
  export CELLD_TTL_MS=30000 CELLD_FETCH_TIMEOUT_S=3600 \
    AWS_ACCESS_KEY_ID=swarmadmin AWS_SECRET_ACCESS_KEY=swarmsecret
  nohup bash -c 'while :; do
    caffeinate -i celld-0.6.2 --bucket s3://pid-cells --endpoint http://127.0.0.1:9000 --listen 127.0.0.1:8093
    echo "pid-celld-supervisor: celld exited ($?), restarting"; sleep 2
  done' pid-celld-supervisor >> .celld.log 2>&1 &
  echo "celld starting (supervisor pid $!)"
fi
wait_port 8093

# Tokens for sandbox commands, from an optional gitignored .env (GH_TOKEN,
# LINEAR_API_KEY); the Providers sheet sets them too. Only keys .env actually
# sets are sent, so it never clears one set in the UI.
if [[ -f .env ]]; then
  python3 - <<'PY'
import json, re, urllib.request
vals = dict(re.findall(r"^[ \t]*(GH_TOKEN|LINEAR_API_KEY)[ \t]*=[ \t]*['\"]?([^'\"\n]+)", open(".env").read(), re.M))
if vals:
    urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8093/api/secrets", method="POST",
        data=json.dumps(vals).encode(), headers={"content-type": "application/json"}))
    print("sandbox tokens loaded from .env:", ", ".join(vals))
PY
fi


echo
echo "pi-durable-sessions is up:"
echo "  api    http://127.0.0.1:8093/api/sessions"
echo "  ui     pnpm ui   →  http://localhost:5176"
echo "  (after editing apps/worker/src/: ./deploy.sh — no restart needed)"
