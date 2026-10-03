#!/bin/bash
# Serve https://a.oxen.sh (tailnet only). Reuses boxen's Cloudflare DNS token.
set -euo pipefail
cd "$(dirname "$0")"
CLOUDFLARE_API_TOKEN="$(cat "$HOME/.config/boxen/cloudflare-api-token")"
export CLOUDFLARE_API_TOKEN
export XDG_DATA_HOME="$HOME/Library/Application Support/boxen"  # shares boxen's cert store
exec "$HOME/.local/bin/caddy" run --config Caddyfile --adapter caddyfile
