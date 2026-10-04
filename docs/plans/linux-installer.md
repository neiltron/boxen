# Linux installation test

Status: implemented on `feat/pids-linux-installer`; real-machine acceptance pending.

## Scope

Install a private, single-owner pi-durable-sessions instance on an x86-64 Omarchy/Arch or Ubuntu 22.04+/Debian 12+ systemd host, including an EC2 VM. No preinstalled Node.js, celld, RustFS, or Caddy required. Reuse Docker/Tailscale when present. Agent and interactive paths share one implementation.

Keep the existing development scripts working. Do not change existing machine services while developing this installer.

## Decisions

- Native celld 0.6.1 and Node 24.5.0, downloaded with pinned SHA-256 checksums. RustFS in a digest-pinned Docker image with persistent host directories. Use distro packages for Docker; require permission before package/service mutations.
- celld serves the built UI through an ASSETS binding. Tailscale Serve supplies private HTTPS; Caddy is unnecessary for the default installation.
- Explicit local or Tailscale access only. Never open public ports/security groups, enable Funnel, or overwrite another Tailscale Serve configuration.
- Dedicated service account, systemd restart policy, loopback listeners, generated credentials, bounded health waits, serialized setup, and preserved data on uninstall.
- Source installs for the test; publishing the branch/release is required before a curl URL can install it remotely. Support installing from a checkout now. Record the source content revision; re-running preserves credentials and state.
- CLI: inspect, setup (dry-run and noninteractive), doctor, start, stop, logs, uninstall. Setup also performs explicit source updates. JSON stdout, diagnostics on stderr, actionable errors and nonzero exits. No prompts in automation mode.
- Custom-domain DNS requirements can be inspected by agents, but custom-domain TLS/routing is deferred. Remote previews remain localhost-based: document an SSH port-forward workaround, and report the limitation in health output. Provider OAuth uses paste-redirect fallback without Vite.
- ARM/Graviton and macOS automation are deferred for this test (the current sandbox image is amd64). Reject unsupported hosts before mutations.

## Tasks

- [x] Bootstrap script and management CLI, pinned dependencies and systemd units.
- [x] Production asset routing and tests without altering dev startup.
- [x] Unit/failure-path tests, Linux dry-run tests, isolated live storage/deploy smoke where possible.
- [x] Installation/agent documentation and Better Auth feasibility note.
- [x] Review and fix findings; distinguish local evidence from real-machine acceptance still needed.

## Follow-up requirements retained

Workspace snapshots must be scoped to a session, include its project Git metadata and uncommitted files, and restore before optional sandbox boot hooks. Deletion stops writers, prevents resurrection, and durably retries cleanup of every snapshot generation and temporary upload, including object versions if versioning is used. Session transcripts/artifacts/metadata need consistent deletion; shared user credentials survive session removal.

Accounts: Better Auth identity/session storage can potentially use celld's D1 binding; validate runtime compatibility before adoption. User DOs own provider credentials, settings, and session directory. All session/terminal/artifact/preview/restore/delete entry points require ownership checks. Existing model OAuth `/api/auth/*` paths will need separation from Better Auth routes.

## Verification completed

- 43 offline tests passed locally and on x86-64 Linux with Python 3.10.
- ShellCheck and shell syntax checks passed; non-systemd Linux bootstrap rejects before changing installation paths.
- UI production build and asset/terminal/preview/event checks passed.
- Isolated RustFS + celld deployment served UI HTML, hashed JS, the sessions API, and correct API 404 responses. The smoke test removes its own node/container/volume.
- Structured Codex review (`autoreview --mode local` in an isolated copy containing only this change) finished with no accepted/actionable findings after fixes. Broader-review findings were also addressed: early Funnel checks, persistent Serve ownership/restart intent, restrictive-umask handling, partial uninstall, Docker lifecycle policy, diagnostics and early shell host validation.
- No packages or permanent services were installed on the development Mac. No remote machine was accessed. Actual Linux systemd/reboot, RustFS service-account bind mounts, Tailscale HTTPS and sandbox terminal acceptance remain pending.

## Real-machine acceptance

On both Omarchy and Ubuntu EC2: install from clean checkout, connect through tailnet HTTPS, configure a provider, create a session, run bash, attach Terminal, reboot, reconnect, rerun setup, uninstall/reinstall with state intact. Also test port conflicts, missing Tailscale authorization, existing Serve configuration, and failed deploy. EC2 needs adequate disk/RAM (recommend 8 GiB RAM and 40+ GiB disk), outbound internet, and no public app-port ingress. Restarting celld may destroy ephemeral sandbox workspaces; do not confuse transcript recovery with filesystem durability.
