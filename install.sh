#!/usr/bin/env bash
# Checkout: ./install.sh --access tailscale
# Remote (after publishing): curl -fsSL <raw URL>/install.sh | bash -s -- --access tailscale --yes --no-input
set -euo pipefail

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'This test installer supports Linux x86-64 (Omarchy/Arch, Ubuntu/Debian), not macOS or ARM.' >&2
  exit 2
fi

# The manager (ops/pids.ts) runs on the same checksum-pinned Node the app uses.
# Keep these identical to NODE_URL/NODE_SHA in ops/pids.ts; a test enforces it.
NODE_URL='https://nodejs.org/dist/v24.5.0/node-v24.5.0-linux-x64.tar.gz'
NODE_SHA='369f2a3668dde7e324697040fafdcf442fd198b8c102317145417b3c83a9794a'
NODE_VERSION='v24.5.0'
INSTALLED_NODE='/opt/pi-durable-sessions/node/bin/node'

# All supplied options are passed through to the manager. Only approval and
# dry-run are inspected here, before Node or a source checkout may exist.
approved=false
no_input=false
dry_run=false
for arg in "$@"; do
  case "$arg" in
    --yes) approved=true ;;
    --no-input) no_input=true ;;
    --dry-run|--help|-h) dry_run=true ;;
  esac
done

# Reject unsupported hosts BEFORE downloading anything. Dry-run/help remain
# read-only and can explain why a container or development host is unsupported.
if ! "$dry_run"; then
  ID=''
  VERSION_ID=''
  if [[ -r /etc/os-release ]]; then
    # Standard root-owned OS metadata, not user-supplied shell configuration.
    # shellcheck disable=SC1091
    . /etc/os-release
  fi
  major="${VERSION_ID%%.*}"
  supported=false
  case "$ID" in
    arch|omarchy) supported=true ;;
    ubuntu) if [[ "$major" =~ ^[0-9]+$ ]] && ((10#$major >= 22)); then supported=true; fi ;;
    debian) if [[ "$major" =~ ^[0-9]+$ ]] && ((10#$major >= 12)); then supported=true; fi ;;
  esac
  if ! "$supported" || [[ ! -d /run/systemd/system ]]; then
    echo 'Requires an x86-64 systemd host: Omarchy/Arch, Ubuntu 22.04+, or Debian 12+. No changes made.' >&2
    exit 2
  fi
fi

# Fetching and verifying Node needs only these. Minimal Debian images can lack curl.
missing=()
for tool in curl tar gzip sha256sum; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]})); then
  if "$dry_run"; then
    echo "Missing ${missing[*]}; install curl, tar, gzip and coreutils to inspect the plan." >&2
    exit 2
  fi
  if ! "$approved"; then
    if "$no_input" || ! ( : </dev/tty ) 2>/dev/null; then
      echo "Missing ${missing[*]}. Pass --yes to approve prerequisite installation." >&2
      exit 2
    fi
    read -r -p "Install ${missing[*]} using the system package manager? [y/N] " answer </dev/tty
    [[ "$answer" == y ]] || exit 2
  fi
  elevate=()
  if [[ "$EUID" != 0 ]]; then
    elevate=(sudo)
    if "$no_input"; then elevate+=(-n); fi
  fi
  if command -v pacman >/dev/null; then
    "${elevate[@]}" pacman -S --needed --noconfirm curl ca-certificates tar gzip coreutils >&2
  elif command -v apt-get >/dev/null; then
    "${elevate[@]}" apt-get update >&2
    "${elevate[@]}" apt-get install -y curl ca-certificates tar gzip coreutils >&2
  else
    echo 'Unsupported package manager; install curl, tar, gzip and coreutils manually.' >&2
    exit 2
  fi
fi

staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT

# Reuse the private Node from an earlier install; otherwise fetch and verify it.
if [[ -x "$INSTALLED_NODE" && "$("$INSTALLED_NODE" --version 2>/dev/null)" == "$NODE_VERSION" ]]; then
  node="$INSTALLED_NODE"
else
  echo "Downloading Node ${NODE_VERSION#v} to run the installer." >&2
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --max-time 300 "$NODE_URL" -o "$staging/node.tar.gz"
  if ! echo "$NODE_SHA  $staging/node.tar.gz" | sha256sum --check --status; then
    echo 'Node checksum mismatch; refusing to run the installer.' >&2
    exit 1
  fi
  mkdir "$staging/node"
  tar -xzf "$staging/node.tar.gz" --no-same-owner --strip-components=1 -C "$staging/node"
  node="$staging/node/bin/node"
fi

source_dir=''
# BASH_SOURCE is empty when piped into bash; never assume the caller's cwd.
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [[ -z "$source_dir" || ! -f "$source_dir/ops/pids.ts" ]]; then
  ref="${PIDS_REF:-pi-durable-sessions}"
  if [[ ! "$ref" =~ ^[a-zA-Z0-9._/-]+$ || "$ref" == *..* ]]; then
    echo 'PIDS_REF must be a Git ref or commit SHA, not a URL or path traversal.' >&2
    exit 2
  fi
  echo "Downloading celld-test ref $ref (set PIDS_REF to pin a commit)." >&2
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --max-time 180 \
    "https://codeload.github.com/neiltron/celld-test/tar.gz/$ref" -o "$staging/source.tar.gz"
  mkdir "$staging/source"
  tar -xzf "$staging/source.tar.gz" --strip-components=1 -C "$staging/source"
  source_dir="$staging/source/pi-durable-sessions"
  [[ -f "$source_dir/ops/pids.ts" ]] || { echo "The selected ref does not contain this installer yet." >&2; exit 2; }
fi

# sudo authenticates normally for humans, but must fail immediately for agents.
elevate=()
if ! "$dry_run" && [[ "$EUID" != 0 ]]; then
  elevate=(sudo)
  if "$no_input"; then elevate+=(-n); fi
fi
manager=("$node" --disable-warning=ExperimentalWarning "$source_dir/ops/pids.ts" setup --source "$source_dir" "$@")
if ! "$no_input" && ( : </dev/tty ) 2>/dev/null; then
  "${elevate[@]}" "${manager[@]}" </dev/tty
else
  "${elevate[@]}" "${manager[@]}"
fi
