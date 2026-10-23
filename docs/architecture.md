# How boxen works

Same app as pi-sessions (in neiltron/celld-test): shared pi agent sessions, many browsers per
session, live streaming text, thinking, and tool calls. The difference is
where the agent runs. pi-sessions spawned `pi --mode rpc` on the host behind
`pi-host`; here a [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
Harness runs inside each Session cell, and tools run in a per-session
Sandbox container that celld supervises. There is no host process of our own.

```
browser tabs ⇄ WS ⇄ Session cell ─ Harness over the cell's SQLite ─ model API (fetch)
                        │                     └ ExecutionEnv ⇄ Sandbox cell ⇄ container (bash, /workspace)
                        └ register / touch / credentials → Directory cell ⇄ WS ⇄ sidebar
```

- **Session cell** (`apps/worker/src/session.js`): opens a Harness on `CellSqlite`
  (`apps/worker/src/cell-sqlite.js`, pi-durable's SQLite facade over `storage.sql`).
  Transcript, streamed partials, tool output, and the queue are committed
  there. While a run goes, an alarm stays set, so after a node restart or
  self-fence the cell reopens the Harness and resumes the run with no
  browser attached. A Harness poisoned by a failed commit is closed and
  reopened over the same storage, and browsers reconnect to it. Each WebSocket gets its own
  `watchEvents()` stream (a snapshot, then deltas), which replaces the old
  event log and replay. A prompt sent while the agent works becomes a steer.
- **Sandbox** (`@cloudflare/sandbox`, image in `apps/worker/Dockerfile`): one Linux
  container per session. Everything done to it goes through the session's
  workspace (`apps/worker/src/workspace.js`): restore and clone, the agent's
  `ExecutionEnv` (`apps/worker/src/sandbox-env.js`: read, write, edit, and bash with
  streamed output), the Changes diff, the terminal shell, and previews.
  `apps/worker/workspace.check.js` drives it with an in-memory sandbox.
  The container's disk dies with it, so `apps/worker/src/sandbox.js` checkpoints
  `/workspace` (minus `node_modules`) to the `BACKUP_BUCKET` binding after
  each run and before idle sleep, and restores it into a fresh container
  before the next tool call. Running processes are not restored.
- **Directory cell**: the session list, plus model providers. Any pi-ai
  provider can take an API key or its own sign-in (Providers, bottom of the
  sidebar); credentials live here (`apps/worker/src/credentials.js` is the pi-ai
  `CredentialStore`), never copied from the host's pi. OAuth sign-ins
  redirect to loopback ports, which `apps/ui/vite.config.ts` forwards to the cell;
  pasting the redirect address is the fallback from another machine.
- **Artifacts cell**: what the agent's `artifact` tool shows in the panel
  (markdown, html, svg, mermaid, code), versioned and full-text searchable,
  readable while sandboxes sleep.
- **apps/ui/**: chat beside a resizable, dockable panel (Trellis) with Artifacts,
  Changes, Preview, Terminal, and Events views. It reaches a Session cell
  through the shared client's session client (`useSession` is its React
  binding).
- **packages/client/**: the REST contract and its typed client, and the
  Session WebSocket protocol (`src/protocol.ts`) with the session client
  (`src/session-client.ts`): the reconnecting socket (`src/socket.ts`, which
  the Directory socket uses too), the reducer that folds pi-durable agent
  events (`src/events.ts`), and typed commands. It needs no browser: the
  caller passes the transport (`src/websocket.ts` is the standard WebSocket,
  the same in the browser and in Node). `run()` is one turn for a headless
  caller (see [Run a turn from Node](automation.md#run-a-turn-from-node)).
  `packages/client/session.check.ts` checks it against a scripted socket, and
  `apps/worker/protocol.check.mjs` holds the Session cell's commands to the
  protocol's.
- **Repos**: a session can start from a repo URL; the cell clones it into the
  sandbox once; later containers get it back from the checkpoint. `GH_TOKEN` and
  `LINEAR_API_KEY` from a gitignored `.env` go into each sandbox command's
  env, and the prompt includes the repo's AGENTS.md.

## What went away

| pi-sessions | here |
|---|---|
| `pi-host/server.mjs`: process supervisor, JSONL framing, batched ingest | the Harness in the cell |
| `events` table, replay, synthetic `user_prompt`/`host_*` events | `watchEvents()` snapshot + deltas |
| agent works on your real files | agent works in a per-session container |

## Layout

A pnpm workspace. Install pnpm 10 or later; it switches itself to the version
`packageManager` in `package.json` pins. One `pnpm install` here installs
everything.

Programs live in `apps/`, libraries they share in `packages/`.

| Path | Package | What |
|---|---|---|
| `apps/worker/` | `@boxen/worker` | the cells, `wrangler.jsonc`, the sandbox `Dockerfile`, and their checks |
| `apps/ui/` | `@boxen/ui` | the web app |
| `apps/cli/` | `@boxen/cli` | `boxen`, the command line: list, create and prompt Sessions |
| `apps/mcp/` | `@boxen/mcp` | an MCP server, so another agent can list, create and prompt Sessions and read artifacts |
| `packages/client/` | `@boxen/client` | the API contract (`openapi.json`), the Session WebSocket protocol, and typed clients for both, for the browser and Node |
| `ops/`, `install.sh` | (not a package) | the Linux installer; standalone, imports nothing from the workspace |


## Notes

- **Runtime shims** (`apps/worker/src/index.js`): pi-ai's OAuth flows are registered
  statically (`registerBunOAuthFlows`), and `atob` is patched to accept
  unpadded base64url JWTs.
- **celld I/O belongs to the request that started it.** A fetch begun in a
  continuation of a finished request never completes, so multi-step flows
  (sign-in) keep their first request open as a stream.
- **One shell per sandbox.** The Sandbox SDK runs commands in a long-lived
  shell; each command is wrapped in `bash -c` so an `exit` can't kill it.
- **Prompt.** A preamble, the cwd, and the repo's AGENTS.md. No skills or MCP
  yet: pi-durable's `CodingTools` are the four tools, plus `artifact`.
- celld builds images for `linux/amd64` by default, so on Apple silicon the
  sandbox runs under emulation (`CELLD_CONTAINER_PLATFORM` overrides it; untried).
