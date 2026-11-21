# Installation and operations

Install and operate **boxen** on a single Linux PC or server using `install.sh` and `boxenctl`.

> [!WARNING]
> **Single-owner, unauthenticated server:** Anyone who can reach boxen has full access to Sessions, terminals, and configured provider credentials. Keep it private on `localhost` or a restricted Tailscale tailnet—never expose it to the public internet or enable Tailscale Funnel.

## Requirements

| Requirement | Supported / Recommended |
|---|---|
| **OS & Architecture** | `x86-64` Linux with `systemd`: **Omarchy**, **Arch Linux**, **Ubuntu 22.04+**, or **Debian 12+**. On AWS EC2, choose an **Ubuntu x86-64 AMI** (Amazon Linux and Graviton/ARM are not supported). |
| **Hardware** | At least **8 GiB RAM** and **40+ GiB free disk** for the app, sandbox image builds, and active sandboxes. No GPU required. |
| **Network** | Outbound HTTPS access to GitHub, npm, Docker registries, Tailscale, and your model providers. No inbound public ports required. |
| **Docker** | Local system Docker engine at `/var/run/docker.sock` (installed automatically if absent). Remote Docker contexts and rootless Docker engines are not supported. |
| **Power (desktop hosts)** | Disable automatic sleep/suspend for unattended background agent runs. |

**Sandbox DNS requirement:** `celld` blocks sandbox container traffic to loopback, private, and tailnet IP ranges (`127.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `::1/128`, `fc00::/7`, `fe80::/10`). Setup checks before modifying the host that Docker provides containers at least one public DNS resolver so sessions can clone repositories and install packages. If preflight reports no reachable resolver, set `"dns": ["1.1.1.1", "8.8.8.8"]` in `/etc/docker/daemon.json`, run `sudo systemctl restart docker`, and rerun setup.

---

## Quick install

Download and verify a release archive (see [Releases](releases.md)) or clone a checkout on the target Linux host, then run `./install.sh`.

### Tailscale mode (recommended for remote access)

Exposes boxen over private tailnet HTTPS (`https://<machine>.ts.net`) using Tailscale Serve:

```sh
cd boxen
./install.sh --access tailscale
```

### Local mode

Binds only to `http://localhost:8093` on loopback (for use directly on the Linux PC, or via an SSH tunnel from another machine):

```sh
cd boxen
./install.sh --access local
```

> [!NOTE]
> Choose `--access`, `--port` (default `8093`), and `--storage-port` (default `19000`) during initial installation. `boxenctl` does not change access modes or ports in place.

### What the installer does

1. Validates OS, architecture, `systemd`, port availability, existing Tailscale exposure, and sandbox DNS before modifying the host.
2. Downloads and SHA-256 verifies a private **Node 24.5.0** and **`celld` 0.6.2** into `/opt/boxen/` (without replacing system Node or requiring Python).
3. Installs or reuses distro Docker and required tools (`curl`, `ca-certificates`, `git`, `tar`, `gzip`), plus Tailscale when `--access tailscale` is selected.
4. Creates the dedicated `boxen` service account and private random RustFS credentials in `/etc/boxen/`.
5. Copies the application source into `/opt/boxen/releases/<revision>/`, installs dependencies and builds the UI using the `pnpm` version pinned in `package.json` (fetched via the private Node's `npx`), and deploys the worker, sandbox image, and static UI assets via `celld`.
6. Enables and starts `boxen-storage.service` (digest-pinned RustFS) and `boxen.service` (`celld`), then waits for UI, API, and storage health checks.

### Finishing Tailscale authorization

If Tailscale is not yet logged in or HTTPS certificates are not enabled on your tailnet, setup leaves the working local installation in place, exits with code `3`, and prints the remaining steps:

```sh
sudo tailscale up
# Approve the device in your tailnet (and enable MagicDNS + HTTPS certificates if needed), then finish:
sudo boxenctl setup --access tailscale --yes --no-input
```

### Initial provider setup

Open the URL printed at the end of installation (`https://<machine>.ts.net` or `http://localhost:8093`), go to **Providers**, and add:

- Your model API keys or provider OAuth sign-in
- Optional `GH_TOKEN` and `LINEAR_API_KEY` tokens (injected into session sandbox commands)

> [!TIP]
> **Provider OAuth on a server:** Use the **paste the redirect URL** flow when signing in with OAuth. The development server's local loopback callback listeners are not installed on production hosts.

---

## Remote / curl installation

To install from a published Git tag or reviewed commit without cloning the repository first, substitute the target tag or commit SHA in **both** the download URL and `BOXEN_REF`:

```sh
curl -fsSL https://raw.githubusercontent.com/neiltron/boxen/<COMMIT_OR_TAG>/install.sh \
  -o /tmp/boxen-install.sh
# Inspect /tmp/boxen-install.sh before running:
BOXEN_REF=<COMMIT_OR_TAG> bash /tmp/boxen-install.sh --access tailscale
```

A pipe-to-bash invocation also works (`curl -fsSL ... | BOXEN_REF=<COMMIT_OR_TAG> bash -s -- --access tailscale`), though downloading first lets you review the script.

**How `BOXEN_REF` and verification work:**
- `BOXEN_REF` selects the application source downloaded from GitHub (`codeload.github.com/neiltron/boxen/tar.gz/<ref>`), not just the bootstrap script.
- When unset, `BOXEN_REF` defaults to the installer's own application version tag (currently `v0.1.0-rc.3`), never a moving branch. Until a release tag is published, install from a checkout or pin a reviewed commit SHA explicitly.
- For checksum-verified release archives (`boxen-<version>.tar.gz` + `SHA256SUMS`), follow the [Releases](releases.md) guide.
- Downloading application source trusts the selected GitHub ref. Native `celld` and Node downloads are verified against pinned SHA-256 checksums, RustFS is pinned by image digest, and distro packages plus the official Tailscale installer follow their upstream repositories.

---

## Non-interactive and agent installation

`boxenctl` and `install.sh` support structured JSON output and non-interactive automation.

```sh
# Read-only inspection and dry-run planning (requires any Node 24+; works on macOS too,
# reporting supported_host: false without making any changes):
node infra/boxenctl.ts inspect --json
node infra/boxenctl.ts setup --access tailscale --dry-run --no-input --json

# Non-interactive install (requires root or passwordless/preauthorized sudo):
./install.sh --access tailscale --yes --no-input --json

# Or configure via a JSON file (accepts access, port, storage_port):
printf '%s\n' '{"access":"tailscale","port":8093,"storage_port":19000}' > install.json
./install.sh --config "$PWD/install.json" --yes --no-input --json
```

### Automation behavior

- **`--yes`**: Approves prerequisite packages, service-account creation, systemd units, image pulls, and deployment. It **never** authorizes overwriting another service's ports or Tailscale Serve/Funnel routes.
- **`--no-input`**: Disables all prompts (including `sudo -n` and interactive Tailscale login) and fails immediately with an actionable error when input is missing. Agents provisioning Tailscale should authenticate via Tailscale's own CLI using a protected key file—never put auth keys in command transcripts—then rerun `setup`.
- **JSON output**: All `boxenctl` commands emit JSON automatically when stdout is piped or captured; `--json` forces JSON on a TTY. Build and package output goes to stderr so stdout remains a single JSON document.
- **Locking & retries**: Mutating commands are serialized with a PID lock (`/etc/boxen/install.lock`). Re-running `setup` preserves credentials, data, and unchanged services; failed builds or deploys retain the copied source and credentials for safe retry.
- **Exposure guardrails**: Existing Tailscale configuration is checked before package or service activation (including in `local` mode). Any active Funnel blocks installation. Installer-created Serve routes are tracked in `/etc/boxen/serve.json` so pre-existing routes are never adopted or removed.
- **Dry-run caveat**: Planning can succeed on an unsupported machine; always check `supported_host` in the dry-run JSON.

### Exit codes

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `1` | Operational failure (download/checksum error, build or deploy failure, timeout) |
| `2` | Invalid arguments, unsupported host, missing root or `--yes` approval, or port/config conflict |
| `3` | External action required (Tailscale login/HTTPS approval, conflicting Serve/Funnel, sandbox DNS probe failure, lock busy) or unhealthy `doctor` check |

---

## Managing the server (`boxenctl`)

After installation, manage the server with `/usr/local/bin/boxenctl`:

| Command | Description |
|---|---|
| `boxenctl inspect [--domain HOST] [--json]` | Read-only host, installation, runtime-pin match, and Tailscale status (no root required) |
| `sudo boxenctl doctor [--json]` | Run bounded health checks (systemd units, UI, API, RustFS, sandbox DNS probe, private Tailscale HTTPS route); exits `3` if unhealthy |
| `sudo boxenctl logs [--lines N] [--json]` | Read bounded `journalctl` output for `boxen` and `boxen-storage` (`1..1000`, default `100`) |
| `sudo boxenctl start` | Start `boxen-storage.service` and `boxen.service` |
| `sudo boxenctl stop` | Stop `boxen.service` and `boxen-storage.service` |
| `sudo boxenctl setup [--source DIR] [--yes --no-input]` | Repair/redeploy the retained source, or deploy an explicit matching source checkout |
| `sudo boxenctl uninstall [--yes --no-input]` | Disable and remove systemd units and the owned Tailscale Serve route while preserving all data |

Common operations:

```sh
sudo boxenctl doctor --json
sudo boxenctl logs --lines 100 --json
sudo boxenctl stop       # WARNING: unsaved sandbox container state since the last checkpoint will be lost
sudo boxenctl start
sudo boxenctl setup --yes --no-input                 # repair/redeploy retained source
sudo boxenctl setup --source "$PWD" --yes --no-input # deploy a checkout with matching version/runtime pins
sudo boxenctl uninstall --yes --no-input
```

**Important operational notes:**
- **Stopping or restarting `celld`**: Unsaved files inside live sandbox containers since the last run checkpoint are lost whenever `celld` stops or restarts. Quiesce active sessions and push or checkpoint work before stopping the server.
- **Uninstall boundaries**: `uninstall` removes `boxen.service`, `boxen-storage.service`, `/etc/boxen/serve.json`, and the owned Tailscale Serve root proxy (refusing to remove another service's route, and never removing Docker or Tailscale). It **preserves** `/var/lib/boxen`, `/etc/boxen`, `/opt/boxen`, and `/usr/local/bin/boxenctl` for reinstall. There is currently no data-purge command and no release garbage collector.
- **Health check scope**: `doctor` verifies local UI/API/storage, sandbox DNS, and the local Tailscale Serve route; verify external HTTPS and WebSockets from another tailnet client.

---

## Upgrading and rollback

### Upgrading to a new release

1. Stop starting new turns, wait for active runs to finish, verify workspace checkpoints, and back up `/var/lib/boxen/rustfs/` and `/etc/boxen/credentials.json` off-machine.
2. Obtain the new release archive (or checkout) and run **the new release's `./install.sh`**:

   ```sh
   cd boxen
   ./install.sh --yes --no-input
   ```

**Why you must run the new release's `./install.sh`:** An installed `boxenctl` verifies that the target source's `package.json` version and `infra/runtime.json` pins match its own embedded pins, rejecting mismatches before changing anything. Running `./install.sh` from the new release updates `boxenctl`, replaces mismatched `celld` or Node binaries (recording restart intent before replacement so failed retries still restart), and deploys the new build.

Ordinary worker and UI updates without runtime or unit changes hot-adopt without restarting `celld`. Updates that change runtime binaries or systemd units restart the affected service(s), which clears live sandbox container disks.

### Rollback

Re-run `./install.sh` from an earlier release (or `sudo boxenctl setup --source <dir> --yes --no-input` if the version and runtime pins match). Retained source copies from previous installs live under `/opt/boxen/releases/`.

> [!CAUTION]
> Redeploying older application source does **not** roll back storage schemas or recover lost sandbox files. Check [Releases](releases.md) for version-specific downgrade restrictions before rolling back.

### Legacy migrations

- **Crossing the npm-to-pnpm workspace change (`pnpm-lock.yaml` replaced `package-lock.json`):** An installed `boxenctl` only accepts the lockfile layout it was built for and rejects the other before making changes. Run the new checkout's `./install.sh` once to upgrade across the change (or the older checkout's `./install.sh` to roll back across it).
- **Migrating from `pi-durable-sessions`:** Run this checkout's `./install.sh` once. Setup detects `/etc/pi-durable-sessions/config.json`, stops and removes the `pi-durable-sessions` and `pi-durable-sessions-storage` units, renames `/opt`, `/etc`, and `/var/lib/pi-durable-sessions` to `boxen`, renames the `pids` user and group to `boxen` (preserving UID/GID ownership), removes `/usr/local/bin/pids`, and installs `boxen.service` and `boxen-storage.service`. The S3 bucket (`pid-cells`) and stored Sessions are preserved. Push any uncheckpointed sandbox work first, as restarting `celld` clears live sandbox containers. Migration refuses before stopping anything if any `boxen` directory, user, or group already exists.

---

## What gets installed and security boundaries

| Component | Location / behavior |
|---|---|
| Manager CLI | `/usr/local/bin/boxenctl` invoking `/opt/boxen/manager/boxenctl.ts` via the private Node below |
| Private runtimes | Checksum-pinned `celld` `0.6.2` (`/opt/boxen/bin/celld`) and Node `24.5.0` (`/opt/boxen/node/`); leaves system Node untouched |
| Application sources | `/opt/boxen/releases/<content-revision>/` |
| Settings | `/etc/boxen/config.json` (world-readable) |
| Secrets & route ownership | `/etc/boxen/credentials.json`, `celld.env`, `storage.env`, `serve.json` (root-only, mode `0600`) |
| Durable state | `/var/lib/boxen/rustfs/` (plus `rustfs-logs/`, `cache/`, `watch/`) |
| Service account | `boxen` (non-login system user, member of `docker`) |
| Object store | `boxen-storage.service`: digest-pinned RustFS Docker container on `127.0.0.1:19000` (console disabled) |
| Application server | `boxen.service`: `celld` on `127.0.0.1:8093`, serving API + built UI on one origin |
| Private HTTPS | Tailscale Serve proxying `https://<machine>.ts.net` (443) to `127.0.0.1:8093` |

**How single-origin UI serving works:** Setup builds the UI into `apps/worker/ui-dist` inside the retained release and generates `apps/worker/wrangler.install.jsonc` with an `ASSETS` binding, so `celld` serves both the UI and API directly without Vite or Caddy.

**Systemd integration:** Both units are enabled under `multi-user.target` and `docker.service` (`Requires`/`PartOf=docker.service`), so starting or restarting Docker brings them back. Required service restarts are persisted in `/etc/boxen/config.json` before unit or binary replacement so they survive failed updates.

### Security boundaries

- **No authentication:** Every client allowed to reach boxen shares full control over Sessions, terminals, and configured credentials. Restrict Tailscale grants/ACLs before sharing the URL.
- **No public ports or Funnel:** On EC2 or any cloud host, do **not** open public ingress for ports `8093`, `19000`, or `443`. Never enable Tailscale Funnel. Keep SSH restricted.
- **Docker socket isolation:** The `boxen` service account has access to `/var/run/docker.sock`, which is **host-root-equivalent**—only install trusted releases and dependencies. Individual session sandbox containers do **not** receive the Docker socket or host configuration, and should not be given host-admin or DNS-admin credentials.

---

## Networking, previews, and storage backups

### Using Preview URLs from a remote machine

Preview URLs currently route through `http://p<port>-<session>.localhost:8093`. On a remote laptop, `.localhost` points to your laptop rather than the server. Until remote preview routing is implemented, forward port `8093` over SSH and open the UI via `localhost`:

```sh
# Forward UI, API, and localhost preview host routing:
ssh -N -L 8093:127.0.0.1:8093 your-server
```

Then open `http://localhost:8093` in your local browser (using HTTP through the tunnel also avoids mixed-content preview issues). If boxen was installed with a custom `--port`, forward local `8093` to that server port (`-L 8093:127.0.0.1:<port>`). Chat and Terminal over the `*.ts.net` HTTPS URL work independently without the SSH tunnel.

### Custom domain DNS inspection

To inspect proposed tailnet DNS records for a custom hostname without changing DNS:

```sh
boxenctl inspect --domain sessions.example.com --json
```

This reports `A`/`AAAA` records targeting the host's Tailscale IPs with `proxied: false` and never guesses LAN or public IPs. Custom-domain TLS and remote preview routing are not yet implemented—creating DNS records alone will not make the hostname work, and a custom domain does not add access control. Use the `*.ts.net` URL for now.

### Backing up storage (or using external S3 / R2)

The application itself only talks to `celld`'s Durable Object SQLite storage and the `BACKUP_BUCKET` binding; `celld` persists both to whatever S3-compatible bucket it is started with (`--bucket s3://...` and `--endpoint ...`):

- **Default bundled RustFS (`boxen-storage.service`):** By default, `boxenctl` runs a local digest-pinned RustFS container storing data in `/var/lib/boxen/rustfs/`. Local host storage is not protected against host or disk failure—keep off-machine backups:
  - Do **not** copy live RustFS files while `boxen-storage.service` is running. Either use a storage-aware S3 backup tool, or stop the server (`sudo boxenctl stop`), back up `/var/lib/boxen/rustfs/`, and restart (`sudo boxenctl start`).
  - Back up `/etc/boxen/credentials.json` securely alongside your storage backups. Setup refuses to rotate missing credentials automatically when storage already contains data.
- **External S3 or Cloudflare R2 (custom deployments):** If you run `celld` directly on EC2, ECS, or a custom systemd unit pointed at an AWS S3 or Cloudflare R2 bucket (`celld --bucket s3://<bucket> --endpoint https://<account>.r2.cloudflarestorage.com` with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`), no local RustFS container is needed and Durable Object state plus `/workspace` checkpoints live off-machine in S3/R2 automatically.
- Deleting individual session snapshots and temporary uploads on session deletion is tracked in [plans/linux-installer.md](plans/linux-installer.md) and is separate from `boxenctl uninstall`.

---

## Validation and smoke tests

### Offline checks

From a repository checkout after `pnpm install`:

```sh
pnpm run check:infra                     # infra/boxenctl.test.ts, tsc -p infra, shellcheck install.sh (requires shellcheck)
pnpm --filter @boxen/worker run check  # worker, assets, workspace, contract, and protocol checks
pnpm --filter @boxen/client run check  # client checks including session.check.ts
pnpm check                             # all of the above plus every other workspace check
```

`infra/boxenctl.ts` imports nothing outside the Node standard library (see [ADR-0001](adr/0001-installer-stays-standalone.md)); the root `package.json` only supplies TypeScript and `@types/node` for type-checking.

### Isolated live smoke test

Requires local Docker, `celld` `0.6.2`, `pnpm install`, and `pnpm build`:

```sh
node infra/smoke.ts --celld /path/to/celld-0.6.2
```

This starts a disposable RustFS container, deploys the worker, sandbox image, and built UI assets to an isolated `celld` process, verifies storage, UI HTML/JS assets, API responses, API 404 handling, and Sandbox SDK reader/argv/stream-label paths, and cleans up automatically. It does not exercise model calls, sandbox terminals, Tailscale, or systemd.

For full host verification on Omarchy and Ubuntu EC2 (including reboot and uninstall/reinstall), run the acceptance checklist in [plans/linux-installer.md](plans/linux-installer.md).
