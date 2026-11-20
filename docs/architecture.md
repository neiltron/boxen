# How boxen works

boxen runs shared, persistent `pi` coding agent sessions on `celld` (a local/self-hosted Cloudflare Workers & Durable Objects runtime). Each Session runs a [`pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) agent Harness inside its own Durable Object cell backed by SQLite, while file operations, shell commands, git diffs, interactive terminals, and live previews run inside a per-session Linux container supervised by `celld`. There is no separate host-side agent daemon.

```text
Browser tabs / boxen CLI / MCP server
       │ HTTP & WebSocket
       ▼
Worker Router (apps/worker/src/index.js) ──► static UI assets (env.ASSETS)
  │           │                         └──► Preview proxy (p<port>-<id>.localhost)
  │           │
  │           ├──► Directory cell (singleton)
  │           │      Session list (WS), pi-ai credentials/OAuth, sandbox secrets
  │           │
  │           ├──► Artifacts cell (singleton)
  │           │      Versioned artifacts + SQLite FTS5 search
  │           │
  │           └──► Session cell (one per Session)
  │                  pi-durable Harness over storage.sql ──► Model APIs (fetch)
  │                  watchEvents() live streams + alarm-backed resume
  │                        │
  │                        ▼ ExecutionEnv / diff / terminal / preview
  │                  Sandbox cell (one per Session)
  │                    Linux container (/workspace) ◄──► BACKUP_BUCKET (S3/R2)
```

## Core components

### Worker router (`apps/worker/src/index.js`)

The worker entrypoint dispatches HTTP and WebSocket traffic to the cells:

- **Contract-driven routing**: API routes are built directly from [`packages/client/openapi.json`](../packages/client/openapi.json) by matching each operation's `operationId` and path parameter patterns, so the worker cannot serve undocumented API paths. [`apps/worker/contract.check.mjs`](../apps/worker/contract.check.mjs) verifies every operation against the spec.
- **Preview host routing**: Requests to `p<port>-<sessionId>.localhost` are intercepted before API routing and `OPTIONS` handling so previewed apps own their origin root (absolute asset paths, API routes, and WebSocket HMR work unmodified).
- **Static assets**: Installed deployments serve the built web app directly through `env.ASSETS` for non-`/api/*` `GET`/`HEAD` requests.

### Session cell (`apps/worker/src/session.js`, `apps/worker/src/cell-sqlite.js`)

Each Session is a Durable Object that owns one agent loop and its durable transcript:

- **Durable Harness over SQLite**: `Session` opens a `pi-durable` `Harness` on `CellSqlite` (`cell-sqlite.js`), a serialized SQLite facade over `state.storage.sql` that executes durable transactions inside `storage.transaction`. Transcripts, streaming partials, tool outputs, and the prompt queue are committed directly in the cell's SQLite database.
- **Alarm-backed run continuation**: Whenever a run starts, the cell schedules a Durable Object alarm (`alarm()` / `watchRun()`). After a node restart or self-fence, the alarm reopens the Harness and resumes the interrupted run even with no browser connected, then checkpoints the workspace once idle.
- **Automatic recovery on commit failure**: If a storage failure poisons the active Harness, `reopen()` closes it, closes connected WebSockets with code `4000` (`"session reopened"`), and schedules an immediate alarm to open a fresh Harness over the same SQLite storage so clients reconnect and continue.
- **Live streaming and steering**: Every WebSocket client gets its own `watchEvents()` stream—an initial `snapshot` followed by commit-level deltas. Prompts sent while the agent is busy are queued as steers (`steeringMode: "all"`) and enter the run at the next tool-round boundary. If a run aborts or fails before reaching a boundary, the cell withdraws leftover queued prompts (`unanswered` / `aborted`) once idle so prompts are never stranded.
- **Auto-titling**: Sessions without an explicit name are titled once from their first prompt using the Session's model at its lowest reasoning level; a manual rename always wins over an in-flight auto-title.

### Sandbox & workspace (`apps/worker/src/workspace.js`, `apps/worker/src/sandbox-env.js`, `apps/worker/src/sandbox.js`, `apps/worker/Dockerfile`)

Each Session gets an isolated Linux container managed through `@cloudflare/sandbox`:

- **Container image (`apps/worker/Dockerfile`)**: Based on `cloudflare/sandbox`, adding `gh`, `ripgrep`, and `python3` alongside `git`, `node`, and `bun`, and exposing common dev-server ports (`3000`, `3001`, `4000`, `4173`, `4321`, `5000`, `5173`, `5174`, `8000`, `8080`, `8787`, `8888`) for macOS previews.
- **Workspace seam (`workspace.js`)**: All container operations go through one module—checkpoint restore and initial `git clone`, the agent's `ExecutionEnv`, the Changes view (`git diff HEAD` including untracked files via a temporary index so the agent's staging area stays untouched), the interactive Terminal PTY (`terminal-<id>`), and Preview port discovery/proxying. [`apps/worker/workspace.check.js`](../apps/worker/workspace.check.js) exercises this module against an in-memory sandbox fake.
- **Agent `ExecutionEnv` (`sandbox-env.js`)**: Implements `pi-durable`'s file and command interface for `read`, `write`, `edit`, and `bash` (with streamed stdout/stderr over SSE). Configured sandbox secrets (`GH_TOKEN`, `LINEAR_API_KEY`) are injected per command—with `GH_TOKEN` wired into git via `GIT_CONFIG_*` environment variables—without writing secrets to container disk.
- **Workspace checkpointing (`sandbox.js`)**: Because a container's disk is discarded on idle sleep or host/Docker restart, `Sandbox.checkpoint()` snapshots `/workspace` (excluding `node_modules`) to the `BACKUP_BUCKET` object store (R2/S3-compatible, such as local RustFS) after each completed run and inside `onActivityExpired()` before idle sleep. Before the next tool call, diff, or terminal attach, `prepare()` checks a container marker (`/tmp/.pds-prepared`) and restores the latest checkpoint into a fresh container. Running processes are not preserved across restarts.
- **Git repositories**: When a Session is created with a repo URL (and optional branch), `workspace.js` clones it once into `/workspace/<repo>`; later container boots restore it from the workspace checkpoint.

### Directory cell (`apps/worker/src/directory.js`, `apps/worker/src/credentials.js`)

A singleton Durable Object that coordinates fleet-wide metadata and credentials:

- **Session registry**: Tracks every Session's metadata, status (`running` / `idle`), archive state, and last activity timestamp, pushing updates to sidebar WebSockets (throttled to 150 ms).
- **Model provider credentials (`credentials.js`)**: Implements `pi-ai`'s `CredentialStore` over SQLite so every Session shares one set of API keys and OAuth tokens (including token refreshes), kept completely separate from any host-level `pi` configuration.
- **OAuth sign-in flows**: In local development, [`apps/ui/vite.config.ts`](../apps/ui/vite.config.ts) listens on provider loopback callback ports (`1455`, `1456`, `53692`) and forwards callbacks to `/api/auth/callback`. When connecting from another machine, users can paste the redirect URL into the UI (`/api/auth/finish`).
- **Sandbox secrets & GitHub metadata**: Stores `GH_TOKEN` and `LINEAR_API_KEY` (exposing only key names via `GET /api/secrets`, never values) and proxies GitHub repository and branch lookups for the new-Session form.

### Artifacts cell (`apps/worker/src/artifacts.js`)

A singleton Durable Object backing the agent's `artifact` tool (`markdown`, `html`, `svg`, `mermaid`, `code`). Each save increments the artifact's version, stores full version history, and updates an SQLite FTS5 full-text index (`porter unicode61`). Because artifacts live in their own cell rather than inside containers, they remain readable and searchable even while Session sandboxes are asleep.

### Web UI (`apps/ui/`) & shared client (`packages/client/`)

- **`packages/client/`**: Defines the REST contract ([`openapi.json`](../packages/client/openapi.json)), generated TypeScript types (`src/openapi.ts`) and typed `apiClient()`, the Session WebSocket protocol ([`src/protocol.ts`](../packages/client/src/protocol.ts)), the reconnecting WebSocket helper ([`src/socket.ts`](../packages/client/src/socket.ts), shared by Session and Directory), the `pi-durable` event reducer ([`src/events.ts`](../packages/client/src/events.ts)), and `sessionClient()` ([`src/session-client.ts`](../packages/client/src/session-client.ts)). It has no browser dependencies: callers pass a `Transport` ([`src/websocket.ts`](../packages/client/src/websocket.ts) wraps standard `WebSocket` for both browsers and Node). `run()` exposes single-turn execution for headless callers (see [Run a turn from Node](automation.md#run-a-turn-from-node)).
- **`apps/ui/`**: React web app binding `sessionClient()` through `useSession`, pairing the chat stream with a resizable, dockable Trellis side panel for Artifacts, Changes, Preview, Terminal, and Events.
- **Protocol checks**: [`packages/client/session.check.ts`](../packages/client/session.check.ts) tests `sessionClient` against a scripted socket, and [`apps/worker/protocol.check.mjs`](../apps/worker/protocol.check.mjs) ensures `Session.commands` matches `SESSION_COMMANDS`.

## Repository layout

boxen is a `pnpm` workspace (`pnpm` 10+ automatically switches to the version pinned in `package.json`). A single `pnpm install` at the root installs every package. Applications live in `apps/`, shared libraries in `packages/`.

| Path | Package | Responsibility |
|---|---|---|
| `apps/worker/` | `@boxen/worker` | Durable Object cells (`Session`, `Directory`, `Artifacts`, `Sandbox`), worker router, `wrangler.jsonc`, sandbox `Dockerfile`, and worker checks |
| `apps/ui/` | `@boxen/ui` | React + Vite web application (chat + Trellis workspace panel) |
| `apps/cli/` | `@boxen/cli` | `boxen` CLI for listing, creating, and prompting Sessions |
| `apps/mcp/` | `@boxen/mcp` | Stdio MCP server exposing Sessions and artifacts to external agents |
| `packages/client/` | `@boxen/client` | `openapi.json` REST contract, Session WebSocket protocol, and typed clients for browsers and Node |
| `ops/`, `install.sh` | *(standalone)* | Linux installer and `boxenctl` operations tooling; imports nothing from the workspace |

## Runtime notes

- **Runtime shims (`apps/worker/src/index.js`)**: `registerBunOAuthFlows()` registers `pi-ai`'s OAuth flows statically so the worker bundler includes them, and `globalThis.atob` is patched to accept unpadded base64url JWT payloads.
- **Request-scoped I/O in `celld`**: I/O in `celld` belongs to the request or event handler that started it—a `fetch` initiated from a continuation of a finished request never completes. Consequently:
  - OAuth sign-in (`POST /api/auth/login`) keeps its first HTTP response open as an NDJSON stream with 15 s keepalives until the token exchange finishes.
  - `Session.holdRun()` keeps a prompt's WebSocket handler open while the run executes (up to 240 s, staying safely under `celld`'s 300 s handler budget).
  - Building a tool's `ExecutionEnv` calls `prepareWorkspace()` over a cell RPC so waiting on an in-flight restore/clone stays bound to an active handler.
- **Single long-lived shell wrapped in `bash -c`**: `@cloudflare/sandbox` executes commands inside one persistent shell per container. `sandbox-env.js` wraps each command in `bash -c` so a script calling `exit` cannot kill the container's exec shell.
- **System prompt and tools**: `apps/worker/src/session.js` assembles the system prompt from a concise preamble, the working directory (`cwd`), and the repository's `AGENTS.md` (falling back to `CLAUDE.md`), re-reading project instructions on each request. Agents have `pi-durable`'s four `CodingTools` (`read`, `write`, `edit`, `bash`) plus `artifact` (no skills or in-agent MCP tools yet).
- **Apple Silicon container emulation**: `celld` builds sandbox images for `linux/amd64` by default, so containers run under emulation on Apple Silicon Macs (`CELLD_CONTAINER_PLATFORM` overrides this, though it is untried).

---

*Historical note: boxen evolved from an earlier `pi-sessions` prototype that ran host-side `pi --mode rpc` processes, replacing the host bridge with in-cell `pi-durable` Harnesses and per-session Sandbox containers.*
