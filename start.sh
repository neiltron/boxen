#!/bin/bash
# Launch boxen: rustfs (shared, :9000) -> celld 0.6.2 node (:8093).
# Needs a Docker daemon for the per-session Sandbox containers.
# UI is separate: pnpm ui (http://localhost:5176), then sign in from the sidebar.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

port_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" 2>/dev/null
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

wait_port() {
  local port="$1"
  local label="${2:-service}"
  for _ in $(seq 1 30); do
    port_open "$port" && return 0
    sleep 0.3
  done
  echo "error: timed out waiting for port $port ($label)" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH (requires Node >=24.5.0 <25)" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker daemon is not running (on macOS with OrbStack, run: orbctl start)" >&2
  exit 1
fi

if ! port_open 9000; then
  if ! command -v rustfs >/dev/null 2>&1; then
    echo "error: rustfs not found on PATH (install rustfs or place it in ~/.local/bin/rustfs)" >&2
    exit 1
  fi
  RUSTFS_ACCESS_KEY=swarmadmin RUSTFS_SECRET_KEY=swarmsecret \
    rustfs server --address 127.0.0.1:9000 ../.rustfs-data >> ../.rustfs.log 2>&1 &
  echo "rustfs starting (pid $!)"
else
  echo "rustfs already listening on 127.0.0.1:9000"
fi
wait_port 9000 "rustfs; check ../.rustfs.log"

if ! port_open 8093; then
  BOXEN_CELLD="celld-0.6.2" node ops/celld.mjs --version >/dev/null
  # celld cuts outbound fetches (whole response included) at its default
  # timeout, 120s as observed: long model streams and long sandbox commands
  # (npm install under emulation) died with "error decoding response body".
  # A missed lease renewal (the Mac sleeping) makes celld halt on purpose
  # ("SELF-FENCE" in .celld.log), so a loop restarts it. caffeinate -i holds
  # off idle sleep on macOS while it runs; a closed lid still sleeps.
  export CELLD_TTL_MS=30000 CELLD_FETCH_TIMEOUT_S=3600 \
    AWS_ACCESS_KEY_ID=swarmadmin AWS_SECRET_ACCESS_KEY=swarmsecret
  nohup bash -c 'while :; do
    if command -v caffeinate >/dev/null 2>&1; then
      caffeinate -i celld-0.6.2 --bucket s3://pid-cells --endpoint http://127.0.0.1:9000 --listen 127.0.0.1:8093
    else
      celld-0.6.2 --bucket s3://pid-cells --endpoint http://127.0.0.1:9000 --listen 127.0.0.1:8093
    fi
    echo "boxen-celld-supervisor: celld exited ($?), restarting"; sleep 2
  done' boxen-celld-supervisor >> .celld.log 2>&1 &
  echo "celld starting (supervisor pid $!)"
else
  echo "celld already listening on 127.0.0.1:8093"
fi
wait_port 8093 "celld; check .celld.log"

# Tokens for sandbox commands, from an optional gitignored .env (GH_TOKEN,
# LINEAR_API_KEY); the Providers sheet sets them too. Only keys .env actually
# sets are sent, so it never clears one set in the UI.
if [[ -f .env ]]; then
  node --input-type=module -e '
    import fs from "node:fs";
    const vals = {};
    for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^[ \t]*(?:export[ \t]+)?(GH_TOKEN|LINEAR_API_KEY)[ \t]*=[ \t]*(.*)/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("\x27") && value.endsWith("\x27"))) {
        value = value.slice(1, -1);
      }
      if (value) vals[match[1]] = value;
    }
    const keys = Object.keys(vals);
    if (keys.length === 0) process.exit(0);
    const res = await fetch("http://127.0.0.1:8093/api/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(vals),
    });
    if (!res.ok) {
      console.error("warning: failed to load .env tokens (HTTP " + res.status + "); if this is a first run, run \"pnpm run deploy\" and re-run \"./start.sh\".");
      process.exit(0);
    }
    console.log("sandbox tokens loaded from .env:", keys.join(", "));
  '
fi

echo
echo "boxen is up:"
echo "  api     http://127.0.0.1:8093/api/sessions"
echo "  ui      pnpm ui   ->  http://localhost:5176"
echo "  logs    ../.rustfs.log, .celld.log"
echo "  deploy  ./deploy.sh  (after editing apps/worker/src/ — no restart needed)"
echo "  stop    ./stop.sh    (or ./stop.sh rustfs to stop storage too)"
