#!/bin/bash
# Convenience runner for local development: starts celld 0.6.2 (:8093) backed by
# either external S3/R2 (when BOXEN_S3_BUCKET / BOXEN_S3_ENDPOINT / AWS_* are
# set in .env or the environment) or a zero-config local rustfs (:9000).
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

read_dotenv() {
  local key="$1"
  [[ -f .env ]] || return 0
  node --input-type=module -e '
    import fs from "node:fs";
    const key = process.argv[1];
    for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = line.match(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)/);
      if (!m || m[1] !== key) continue;
      let v = m[2].trim();
      if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("\x27") && v.endsWith("\x27"))) v = v.slice(1, -1);
      process.stdout.write(v);
      process.exit(0);
    }
  ' "$key"
}

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH (requires Node >=24.5.0 <25)" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker daemon is not running (on macOS with OrbStack, run: orbctl start)" >&2
  exit 1
fi

# Resolve S3/R2 storage configuration from environment or .env.
CFG_BUCKET="${BOXEN_S3_BUCKET:-$(read_dotenv BOXEN_S3_BUCKET)}"
CFG_ENDPOINT="${BOXEN_S3_ENDPOINT:-$(read_dotenv BOXEN_S3_ENDPOINT)}"
CFG_KEY="${AWS_ACCESS_KEY_ID:-$(read_dotenv AWS_ACCESS_KEY_ID)}"
CFG_SECRET="${AWS_SECRET_ACCESS_KEY:-$(read_dotenv AWS_SECRET_ACCESS_KEY)}"
CFG_REGION="${AWS_REGION:-$(read_dotenv AWS_REGION)}"

USE_LOCAL_RUSTFS=1
if [[ -n "$CFG_BUCKET" || -n "$CFG_ENDPOINT" || -n "$CFG_KEY" ]]; then
  if [[ "$CFG_ENDPOINT" != "http://127.0.0.1:9000" && "$CFG_ENDPOINT" != "http://localhost:9000" ]]; then
    USE_LOCAL_RUSTFS=0
  fi
fi

if [[ "$USE_LOCAL_RUSTFS" -eq 1 ]]; then
  S3_BUCKET="${CFG_BUCKET:-s3://pid-cells}"
  S3_ENDPOINT="http://127.0.0.1:9000"
  export AWS_ACCESS_KEY_ID="${CFG_KEY:-swarmadmin}"
  export AWS_SECRET_ACCESS_KEY="${CFG_SECRET:-swarmsecret}"
  export AWS_REGION="${CFG_REGION:-us-east-1}"

  if ! port_open 9000; then
    if ! command -v rustfs >/dev/null 2>&1; then
      echo "error: rustfs not found on PATH (install rustfs in ~/.local/bin/rustfs, or configure external S3/R2 via BOXEN_S3_BUCKET and BOXEN_S3_ENDPOINT in .env)" >&2
      exit 1
    fi
    RUSTFS_ACCESS_KEY="$AWS_ACCESS_KEY_ID" RUSTFS_SECRET_KEY="$AWS_SECRET_ACCESS_KEY" \
      rustfs server --address 127.0.0.1:9000 ../.rustfs-data >> ../.rustfs.log 2>&1 &
    echo "rustfs starting (pid $!)"
  else
    echo "rustfs already listening on 127.0.0.1:9000"
  fi
  wait_port 9000 "rustfs; check ../.rustfs.log"
else
  S3_BUCKET="${CFG_BUCKET:-s3://pid-cells}"
  S3_ENDPOINT="$CFG_ENDPOINT"
  export AWS_ACCESS_KEY_ID="$CFG_KEY"
  export AWS_SECRET_ACCESS_KEY="$CFG_SECRET"
  export AWS_REGION="${CFG_REGION:-auto}"
  echo "using external object storage: ${S3_BUCKET}${S3_ENDPOINT:+ ($S3_ENDPOINT)} (skipping local rustfs)"
fi

if [[ "$S3_BUCKET" != s3://* ]]; then
  S3_BUCKET="s3://$S3_BUCKET"
fi
export BOXEN_S3_BUCKET="$S3_BUCKET"
export BOXEN_S3_ENDPOINT="$S3_ENDPOINT"

if ! port_open 8093; then
  BOXEN_CELLD="celld-0.6.2" node ops/celld.mjs --version >/dev/null
  # celld cuts outbound fetches (whole response included) at its default
  # timeout, 120s as observed: long model streams and long sandbox commands
  # (npm install under emulation) died with "error decoding response body".
  # A missed lease renewal (the Mac sleeping) makes celld halt on purpose
  # ("SELF-FENCE" in .celld.log), so a loop restarts it. caffeinate -i holds
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
echo "  api      http://127.0.0.1:8093/api/sessions"
echo "  storage  ${S3_BUCKET}${S3_ENDPOINT:+ ($S3_ENDPOINT)}"
echo "  ui       pnpm ui   ->  http://localhost:5176"
echo "  logs     .celld.log$([[ "$USE_LOCAL_RUSTFS" -eq 1 ]] && echo ", ../.rustfs.log" || true)"
echo "  deploy   ./deploy.sh  (after editing apps/worker/src/ — no restart needed)"
echo "  stop     ./stop.sh$([[ "$USE_LOCAL_RUSTFS" -eq 1 ]] && echo "    (or ./stop.sh rustfs to stop local storage too)" || true)"
