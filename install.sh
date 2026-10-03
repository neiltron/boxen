#!/usr/bin/env bash
# Checkout: ./install.sh --access tailscale
# Remote (after publishing): curl -fsSL <raw URL>/install.sh | bash -s -- --access tailscale --yes --no-input
set -euo pipefail

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'This test installer supports Linux x86-64 (Omarchy/Arch, Ubuntu/Debian), not macOS or ARM.' >&2
  exit 2
fi

# All supplied options are passed through to the manager. Only approval and
# dry-run are inspected here, before Python or a source checkout may exist.
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

# Reject unsupported hosts BEFORE even installing Python. Dry-run/help remain
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

if ! command -v python3 >/dev/null; then
  if "$dry_run"; then
    echo 'Python 3 is required to inspect the plan. Install python (Arch) or python3 (Ubuntu/Debian).' >&2
    exit 2
  fi
  if ! "$approved"; then
    if "$no_input" || ! ( : </dev/tty ) 2>/dev/null; then
      echo 'Python 3 must be installed. Pass --yes to approve prerequisite installation.' >&2
      exit 2
    fi
    read -r -p 'Install Python 3 using the system package manager? [y/N] ' answer </dev/tty
    [[ "$answer" == y ]] || exit 2
  fi
  elevate=()
  if [[ "$EUID" != 0 ]]; then
    elevate=(sudo)
    if "$no_input"; then elevate+=(-n); fi
  fi
  if command -v pacman >/dev/null; then
    "${elevate[@]}" pacman -S --needed --noconfirm python >&2
  elif command -v apt-get >/dev/null; then
    "${elevate[@]}" apt-get update >&2
    "${elevate[@]}" apt-get install -y python3 >&2
  else
    echo 'Unsupported package manager; install Python 3 manually.' >&2
    exit 2
  fi
fi

staging=''
trap 'if [[ -n "$staging" ]]; then rm -rf -- "$staging"; fi' EXIT
source_dir=''
# BASH_SOURCE is empty when piped into bash; never assume the caller's cwd.
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [[ -z "$source_dir" || ! -f "$source_dir/ops/pids.py" ]]; then
  ref="${PIDS_REF:-pi-durable-sessions}"
  if [[ ! "$ref" =~ ^[a-zA-Z0-9._/-]+$ || "$ref" == *..* ]]; then
    echo 'PIDS_REF must be a Git ref or commit SHA, not a URL or path traversal.' >&2
    exit 2
  fi
  staging="$(mktemp -d)"
  echo "Downloading celld-test ref $ref (set PIDS_REF to pin a commit)." >&2
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --max-time 180 \
    "https://codeload.github.com/neiltron/celld-test/tar.gz/$ref" -o "$staging/source.tar.gz"
  tar -xzf "$staging/source.tar.gz" --strip-components=1 -C "$staging"
  source_dir="$staging/pi-durable-sessions"
  [[ -f "$source_dir/ops/pids.py" ]] || { echo "The selected ref does not contain this installer yet." >&2; exit 2; }
fi

# sudo authenticates normally for humans, but must fail immediately for agents.
elevate=()
if ! "$dry_run" && [[ "$EUID" != 0 ]]; then
  elevate=(sudo)
  if "$no_input"; then elevate+=(-n); fi
fi
if ! "$no_input" && ( : </dev/tty ) 2>/dev/null; then
  "${elevate[@]}" python3 "$source_dir/ops/pids.py" setup --source "$source_dir" "$@" </dev/tty
else
  "${elevate[@]}" python3 "$source_dir/ops/pids.py" setup --source "$source_dir" "$@"
fi
