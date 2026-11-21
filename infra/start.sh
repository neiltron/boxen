#!/bin/bash
# Convenience runner for local development: starts celld 0.6.2 (:8093) backed by
# either external S3/R2 (when BOXEN_S3_BUCKET / BOXEN_S3_ENDPOINT is set in
# .env or the environment) or a zero-config local rustfs (:9000).
# Needs a Docker daemon for the per-session Sandbox containers.
# Run from anywhere: pnpm start. UI is separate: pnpm ui (http://localhost:5176).
set -euo pipefail
cd "$(dirname "$0")/.."
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

# Local storage data and logs (gitignored).
mkdir -p .data

# Storage settings (environment or .env) resolved in one place, shared with deploys.
eval "$(node infra/celld.mjs --storage-env)"

if [[ "$BOXEN_STORAGE" == local ]]; then
  if ! port_open 9000; then
    if ! command -v rustfs >/dev/null 2>&1; then
      echo "error: rustfs not found on PATH (install rustfs in ~/.local/bin/rustfs, or set BOXEN_S3_BUCKET / BOXEN_S3_ENDPOINT in .env for external S3/R2)" >&2
      exit 1
    fi
    # One-time move from the old location beside the checkout. Only while
    # rustfs is stopped, so a running one never loses its directory.
    if [[ -d ../.rustfs-data && ! -e .data/rustfs ]]; then
      mv ../.rustfs-data .data/rustfs
      echo "moved local storage from ../.rustfs-data to .data/rustfs"
    fi
    RUSTFS_ACCESS_KEY="$AWS_ACCESS_KEY_ID" RUSTFS_SECRET_KEY="$AWS_SECRET_ACCESS_KEY" \
      rustfs server --address 127.0.0.1:9000 "$PWD/.data/rustfs" >> .data/rustfs.log 2>&1 &
    echo "rustfs starting (pid $!)"
  else
    echo "rustfs already listening on 127.0.0.1:9000"
  fi
  wait_port 9000 "rustfs; check .data/rustfs.log"
else
  echo "using external object storage: ${BOXEN_S3_BUCKET}${BOXEN_S3_ENDPOINT:+ ($BOXEN_S3_ENDPOINT)} (skipping local rustfs)"
fi

if ! port_open 8093; then
  BOXEN_CELLD="celld-0.6.2" node infra/celld.mjs --version >/dev/null
  # celld cuts outbound fetches (whole response included) at its default
  # timeout, 120s as observed: long model streams and long sandbox commands
  # (npm install under emulation) died with "error decoding response body".
  # A missed lease renewal (the Mac sleeping) makes celld halt on purpose
  # ("SELF-FENCE" in .data/celld.log), so a loop restarts it. caffeinate -i holds
  # off idle sleep on macOS while it runs; a closed lid still sleeps.
  export CELLD_TTL_MS=30000 CELLD_FETCH_TIMEOUT_S=3600
  # shellcheck disable=SC2016
  nohup bash -c 'while :; do
    args=(--bucket "$BOXEN_S3_BUCKET" --listen 127.0.0.1:8093)
    if [[ -n "${BOXEN_S3_ENDPOINT:-}" ]]; then
      args+=(--endpoint "$BOXEN_S3_ENDPOINT")
    fi
    if command -v caffeinate >/dev/null 2>&1; then
      caffeinate -i celld-0.6.2 "${args[@]}"
    else
      celld-0.6.2 "${args[@]}"
    fi
    echo "boxen-celld-supervisor: celld exited ($?), restarting"; sleep 2
  done' boxen-celld-supervisor >> .data/celld.log 2>&1 &
  echo "celld starting (supervisor pid $!)"
else
  echo "celld already listening on 127.0.0.1:8093"
fi
wait_port 8093 "celld; check .data/celld.log"

# A fresh bucket has no worker yet: deploy once, then wait for celld to adopt it
# (its pointer poll is ~15s) so the tokens below have an API to land in.
deployed() { curl -fsS -o /dev/null http://127.0.0.1:8093/api/sessions 2>/dev/null; }
if ! deployed; then
  echo "no worker deployed yet; deploying"
  pnpm run deploy
  for _ in $(seq 1 60); do deployed && break; sleep 1; done
  deployed || { echo "error: celld did not pick up the deploy; check .data/celld.log" >&2; exit 1; }
fi

# Tokens for sandbox commands, from an optional gitignored .env (GH_TOKEN,
# LINEAR_API_KEY); the Providers sheet sets them too. Only keys .env actually
# sets are sent, so it never clears one set in the UI.
if [[ -f .env ]]; then
  node --input-type=module -e '
    import fs from "node:fs";
    import { parseEnv } from "node:util";
    const env = parseEnv(fs.readFileSync(".env", "utf8"));
    const vals = Object.fromEntries(["GH_TOKEN", "LINEAR_API_KEY"].filter((k) => env[k]).map((k) => [k, env[k]]));
    const keys = Object.keys(vals);
    if (keys.length === 0) process.exit(0);
    const res = await fetch("http://127.0.0.1:8093/api/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(vals),
    });
    if (!res.ok) {
      console.error("warning: failed to load .env tokens (HTTP " + res.status + ")");
      process.exit(0);
    }
    console.log("sandbox tokens loaded from .env:", keys.join(", "));
  '
fi

rustfs_log="" rustfs_stop=""
if [[ "$BOXEN_STORAGE" == local ]]; then
  rustfs_log=", .data/rustfs.log"
  rustfs_stop="    (or pnpm stop rustfs to stop local storage too)"
fi

echo
echo "boxen is up:"
echo "  api      http://127.0.0.1:8093/api/sessions"
echo "  storage  ${BOXEN_S3_BUCKET}${BOXEN_S3_ENDPOINT:+ ($BOXEN_S3_ENDPOINT)}"
echo "  ui       pnpm ui     ->  http://localhost:5176"
echo "  inbox    pnpm inbox  ->  http://localhost:5177"
echo "  logs     .data/celld.log$rustfs_log"
echo "  deploy   pnpm run deploy  (after editing apps/worker/src/; adopted within ~15s, no restart)"
echo "  stop     pnpm stop$rustfs_stop"
