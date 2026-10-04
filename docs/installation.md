# Install on a Linux PC or server

Experimental single-machine installer for **x86-64 Omarchy/Arch, Ubuntu 22.04+, and Debian 12+**, with systemd. For EC2, choose an **Ubuntu x86-64 AMI**, not Amazon Linux or Graviton. Start with 8 GiB RAM and 40+ GiB disk for the app, image builds and a few sandboxes. No GPU needed. Disable desktop suspend for unattended work.

## First test from a checkout

On the target machine, obtain a checkout containing this installer, then:

```sh
cd celld-test/pi-durable-sessions
./install.sh --access tailscale
```

The installer requests sudo/approval, installs prerequisites, builds the UI, deploys the worker and sandbox image, and registers services. If Tailscale needs a login or HTTPS certificate approval, it keeps the local installation and returns instructions. For a login:

```sh
sudo tailscale up
# Approve the device in your tailnet, then finish:
sudo pids setup --access tailscale --yes --no-input
```

Open the printed HTTPS URL. Add your model API key or provider sign-in in Providers; GitHub/Linear tokens also belong there. Provider OAuth uses **paste the redirect URL**: the dev server's loopback callback listeners are not installed.

For use entirely on the PC, choose `--access local` instead and open `http://localhost:8093`. On EC2, local mode can also be reached through an SSH tunnel. The first test doesn't switch access modes/ports in place; choose them at initial setup.

### Curl installation, after publishing

The installer must first be committed and published. The unpushed development branch is **not** a working remote installation URL. After publishing a tested commit, substitute its SHA in both places:

```sh
curl -fsSL https://raw.githubusercontent.com/neiltron/celld-test/<COMMIT>/pi-durable-sessions/install.sh \
  -o /tmp/pids-install.sh
PIDS_REF=<COMMIT> bash /tmp/pids-install.sh --access tailscale
```

A pipe-to-bash invocation works too; downloading first lets you inspect the script. `PIDS_REF` selects the application source, not just the installer. It defaults to `pi-durable-sessions`; pin a commit for reproducibility. Downloading the application trusts that GitHub ref; native celld/Node downloads also have pinned SHA-256 checksums. The installer itself runs on that same pinned Node, which `install.sh` downloads and verifies first, so the host needs no Python or other runtime. RustFS is pinned by image digest. Distro packages and the official Tailscale repository installer follow their upstream updates.

## Agent/noninteractive installation

```sh
# Read-only, with any Node 24+. Works on a development Mac too; reports supported_host: false rather than installing.
node ops/pids.ts inspect --json
node ops/pids.ts setup --access tailscale --dry-run --no-input --json

# Approved mutations. With passwordless/preauthorized sudo; never prompts for missing inputs.
./install.sh --access tailscale --yes --no-input --json

# Or pass desired settings as JSON:
printf '%s\n' '{"access":"tailscale","port":8093,"storage_port":19000}' > install.json
./install.sh --config "$PWD/install.json" --yes --no-input --json
```

`--yes` approves packages, service-account creation, service installation/start, image pulls and deployment. It does not authorize overwriting another service's ports or Tailscale Serve/Funnel routes. No-input mode never performs interactive login. Agents with Tailscale provisioning credentials can authorize the host using Tailscale's own CLI, then rerun setup. Don't put auth keys in command transcripts; use Tailscale's protected key-file mechanism.

All management commands emit JSON when stdout is captured/piped; `--json` makes this explicit. Build/package logs go to stderr. Exit codes: **0** success, **2** invalid input/unsupported host/approval required, **3** external action required or unhealthy status, **1** other operation failures. Review `supported_host` in a dry-run result: planning itself can succeed on an unsupported machine. `logs` returns at most 100 lines by default (`--lines 1..1000`).

Missing Tailscale authorization leaves a usable **local** installation, with exit 3 and an actionable message. A failed build/deploy leaves source and credentials available for retry. Setup is serialized with a lock. Existing Tailscale exposure is checked before package/service activation (including local mode); any existing Funnel configuration blocks installation. Installer-created Serve routes have a private ownership record, so a coincidentally matching pre-existing proxy is not adopted. Re-running preserves storage credentials, data and unchanged services; ordinary worker deployment is adopted without restarting celld. Changes requiring service restart can destroy ephemeral sandbox workspaces.

## Manage it

```sh
sudo pids doctor --json
sudo pids logs --lines 100 --json
sudo pids stop       # WARNING: sandbox workspaces may be lost
sudo pids start
sudo pids setup --yes --no-input  # repair/redeploy the retained source

# Explicit source update, after obtaining a newer checkout:
sudo pids setup --source "$PWD" --yes --no-input

sudo pids uninstall --yes --no-input
```

Uninstall disables/removes the two app services and removes its exact Tailscale root proxy if still owned. It **preserves all data, credentials, source releases, dependencies and the management command** for reinstall. It never removes another service's Serve route and never deletes Docker/Tailscale globally. This test has no purge command and no release garbage collector.

Rollback: rerun setup with an earlier source checkout. This redeploys application code; it does **not** roll back database schemas or recover sandbox files. Old retained source releases live under `/opt/pi-durable-sessions/releases/`.

## What gets installed

| Component | Location / behavior |
|---|---|
| Manager | `/usr/local/bin/pids`, `/opt/pi-durable-sessions/manager/pids.ts`, run by the private Node below |
| Native runtimes | Private celld 0.6.1 and Node 24.5.0 under `/opt/pi-durable-sessions/`; no global Node replacement |
| Application sources | `/opt/pi-durable-sessions/releases/<content-revision>/` |
| Settings | `/etc/pi-durable-sessions/config.json` |
| Credentials / route ownership | `/etc/pi-durable-sessions/credentials.json`, `celld.env`, `storage.env`, `serve.json`; root-only |
| Durable state | `/var/lib/pi-durable-sessions/rustfs/` plus host-local caches |
| Service account | `pids`, non-login, member of `docker` |
| Object store | Digest-pinned RustFS Docker container, loopback `127.0.0.1:19000`; console disabled |
| Application | `pi-durable-sessions.service`, loopback `127.0.0.1:8093` |
| Storage service | `pi-durable-sessions-storage.service` |
| HTTPS | Tailscale Serve on the machine's `*.ts.net` name |

The dedicated service account's Docker access is **host-root-equivalent**. Only install trusted app releases/dependencies. Session sandboxes do not receive the Docker socket or host configuration. The installer reuses the local system Docker engine at `/var/run/docker.sock`; remote Docker contexts and rootless engines are not supported by this first test.

Both services are enabled under Docker as well as the normal boot target, with Docker restart propagation. Starting Docker after maintenance should bring them back; verify this policy on the target systemd host. Required service restarts are recorded before unit replacement and survive failed updates. Uninstall handles missing units from interrupted installations, while preserving errors for actual service-management failures.

No Vite process and no Caddy are needed: a generated `wrangler.install.jsonc` adds the built UI's ASSETS binding, and celld serves UI + API on one origin. The development `wrangler.jsonc`, `start.sh`, Caddy setup and `npm run ui` remain unchanged.

## Networking and domains

**No public application ports are required.** On EC2, do not add public ingress for 8093, 19000 or 443 on this app's behalf. Keep SSH restricted as appropriate. The machine needs outbound access to GitHub, npm, Docker registries, Tailscale and model providers. Configure Tailscale connectivity according to your tailnet policy. Never enable Funnel for this unauthenticated app.

The application is still single-owner/shared-authority: **anyone permitted to reach it can use sessions, terminals and credentials**. Restrict Tailscale grants before sharing the URL. A domain name does not provide access control.

Agents can discover the actual Tailscale addresses and DNS requirements:

```sh
pids inspect --domain sessions.example.com --json
```

This reports proposed A/AAAA records with `proxied: false`, never guesses a LAN/public IP, and **does not change DNS**. An agent may use its existing DNS-provider tools after approval. But custom-domain TLS and preview routing are not implemented in this test; creating DNS alone won't make that hostname work. Use the generated `ts.net` URL for now. Do not give an ordinary session sandbox host-admin/DNS-admin credentials.

### Previews

Previews currently hardcode `http://p<port>-<session>.localhost:8093`. On a remote client, that points at the client, not the server. Until remote preview routing is added:

```sh
# Forward both UI/API and the localhost preview host routing:
ssh -N -L 8093:127.0.0.1:8093 your-server
# Open http://localhost:8093 in the client browser (not the HTTPS tailnet URL).
```

If installed with a custom `--port`, forward local 8093 to that server port. Even a browser on the server needs port 8093 for the current preview URLs. HTTPS tailnet chat/Terminal work independently; using the local HTTP UI through the tunnel avoids mixed-content preview issues.

## Storage and removal boundaries

Session transcripts/credentials/artifacts live in RustFS. Its host disk is not protected against host/disk loss; keep a separate backup. Do not copy live object-store files and assume that is a consistent backup—use a storage-aware backup, or stop the app and storage first. Preserve the generated credentials alongside protected backups.

Workspace snapshots and session deletion cleanup are **not implemented here**. The follow-up requirement in `plans/linux-installer.md` explicitly includes deletion of every snapshot generation/temporary upload, restart-safe retries and no resurrection. Uninstall preserving installation data is a different operation from deleting an individual session.

## Validation

Offline:

```sh
node --test ops/pids.test.ts
shellcheck install.sh
npm i --no-save typescript @types/node@24 && npx tsc -p ops   # type-check the manager
node --experimental-vm-modules assets.check.mjs
node --experimental-vm-modules terminal.check.mjs
node preview.check.js
(cd ui && node session.check.ts)
```

Live isolated smoke (Docker + celld + esbuild, dependencies installed, UI built):

```sh
node ops/smoke.ts --celld /path/to/celld-0.6.1
```

This creates a disposable RustFS container/volume, deploys the actual worker, sandbox image and UI assets, starts a separate node, checks storage/API/static assets, and cleans up its own node/container/volume. It does not call a model or exercise a sandbox terminal, Tailscale or systemd.

Before calling this installer proven, run the real-machine acceptance checklist in `plans/linux-installer.md` on **both Omarchy and Ubuntu EC2**, including reboot and uninstall/reinstall. `doctor` checks local UI/API/storage and the private Serve mapping; it does not claim an external client has verified HTTPS or WebSockets.
