# pi-durable-sessions — pi-sessions with the agent inside the cell

Same app as `../pi-sessions`: shared pi agent sessions, many browsers per
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

- **Session cell** (`worker/src/session.js`): opens a Harness on `CellSqlite`
  (`worker/src/cell-sqlite.js`, pi-durable's SQLite facade over `storage.sql`).
  Transcript, streamed partials, tool output, and the queue are committed
  there. While a run goes, an alarm stays set, so after a node restart or
  self-fence the cell reopens the Harness and resumes the run with no
  browser attached. A Harness poisoned by a failed commit is closed and
  reopened over the same storage, and browsers reconnect to it. Each WebSocket gets its own
  `watchEvents()` stream (a snapshot, then deltas), which replaces the old
  event log and replay. A prompt sent while the agent works becomes a steer.
- **Sandbox** (`@cloudflare/sandbox`, image in `worker/Dockerfile`): one Linux
  container per session. Everything done to it goes through the session's
  workspace (`worker/src/workspace.js`): restore and clone, the agent's
  `ExecutionEnv` (`worker/src/sandbox-env.js`: read, write, edit, and bash with
  streamed output), the Changes diff, the terminal shell, and previews.
  `worker/workspace.check.js` drives it with an in-memory sandbox.
  The container's disk dies with it, so `worker/src/sandbox.js` checkpoints
  `/workspace` (minus `node_modules`) to the `BACKUP_BUCKET` binding after
  each run and before idle sleep, and restores it into a fresh container
  before the next tool call. Running processes are not restored.
- **Directory cell**: the session list, plus model providers. Any pi-ai
  provider can take an API key or its own sign-in (Providers, bottom of the
  sidebar); credentials live here (`worker/src/credentials.js` is the pi-ai
  `CredentialStore`), never copied from the host's pi. OAuth sign-ins
  redirect to loopback ports, which `ui/vite.config.ts` forwards to the cell;
  pasting the redirect address is the fallback from another machine.
- **Artifacts cell**: what the agent's `artifact` tool shows in the panel
  (markdown, html, svg, mermaid, code), versioned and full-text searchable,
  readable while sandboxes sleep.
- **ui/**: chat beside a resizable, dockable panel (Trellis) with Artifacts,
  Changes, Preview, Terminal, and Events views. The session client
  (`src/lib/session-client.ts`) is the UI's one handle on a Session cell:
  the reconnecting socket, the reducer that folds pi-durable agent events
  (`src/lib/events.ts`), and typed commands. `ui/session.check.ts` checks
  it against a scripted socket.
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

| Path | Package | What |
|---|---|---|
| `worker/` | `@pi-durable-sessions/worker` | the cells, `wrangler.jsonc`, the sandbox `Dockerfile`, and their checks |
| `ui/` | `@pi-durable-sessions/ui` | the web app |
| `ops/`, `install.sh` | (not a package) | the Linux installer; standalone, imports nothing from the workspace |

## Install on a Linux PC or server

Experimental installer for x86-64 Omarchy/Arch and Ubuntu/Debian (including
Ubuntu EC2), with private Tailscale HTTPS and agent-friendly commands:

```sh
./install.sh --access tailscale
```

See [installation, automation, and limitations](docs/installation.md). This
installs separate system services; the development setup below is unchanged.
[Better Auth feasibility](docs/better-auth.md) and workspace snapshots are
follow-ups, not part of this installer.

## Run it

Needs a Docker daemon (`orbctl start`) and celld ≥ 0.5 for containers. This
prototype uses `~/.local/bin/celld-0.6.1`; the other prototypes stay on 0.3.0.

```sh
pnpm install && pnpm run deploy  # bundles the worker, saves the sandbox image to the bucket
./start.sh                       # rustfs (:9000) + celld (:8093) + .env tokens
pnpm ui                          # http://localhost:5176
```

Write `pnpm run deploy`, not `pnpm deploy`: that is a built-in pnpm command.
`pnpm build` builds the UI into `ui/dist`.

After editing `worker/src/`, run `./deploy.sh`. 0.6.1 nodes pick up a new version
in about 15 seconds without a restart, so sandboxes keep their disks.

## Rename and archive

Use the **⋯** menu in a sidebar row or the session header to rename or archive
it. Names are trimmed, limited to 120 characters, and shared with every viewer;
a manual rename wins over an automatic title that is still being generated.

**Archive is organization, not shutdown.** It hides a session from the Active
list for everyone without stopping its agent, deleting files, or making the
conversation read-only. Agent activity does not unarchive it. Switch the sidebar
to **Archived** to find it again, then **Restore** (or use **Undo** immediately
after archiving). Archiving the open session keeps its view and unsent draft;
its header shows **Archived · Restore**.

`PATCH /api/session/:id` accepts `{ "name": "New title" }` and/or
`{ "archived": true }` (`false` restores). Metadata changes neither open the
Harness nor wake its sandbox, and do not bump `lastActivity`. Session metadata
is authoritative and projected to Directory with a revision, so stale updates
are dropped. If that projection fails the request errors; retrying the same
change repairs Directory. Existing records without `archivedAt` remain active.

Checks (Node 22+). `pnpm check` runs every check in the workspace: the
installer's tests and type-check (and `shellcheck install.sh` when shellcheck
is installed), then each package's `check` script (`worker/`: the metadata,
assets and workspace checks; `ui/`: session client, lint, Playwright, build,
built-app smoke).

```sh
pnpm install
pnpm --dir ui exec playwright install --with-deps chromium  # once per machine
pnpm check
pnpm --filter @pi-durable-sessions/worker run check  # or one package
```

The backend check uses real in-memory SQLite with mocked runtime/agent
boundaries. The Chromium smoke check serves the built UI and mocks HTTP/WS;
it checks two-viewer updates, rename failure, archive/undo/restore, draft
preservation, keyboard controls, and narrow-screen menus.
Neither replaces a live celld/deployment smoke test.

## Preview

Start the session's app in its sandbox, listening on `0.0.0.0` (for example,
Vite with `npm run dev -- --host 0.0.0.0 --port 5173`). In the panel's Preview
view, enter its port and press Go/Enter, or use **Find listening ports** and
pick one. The last applied port is saved per session in localStorage; reload
remounts the iframe, and the adjacent link opens the same URL in a new tab.
Ports must be 1024–65535 except **3000**, the Sandbox control server; run Next
on e.g. 3001 instead. On macOS celld can only reach ports the image declares
with `EXPOSE` (see `worker/Dockerfile`: 3001 4000 4173 4321 5000 5173 5174 8000 8080
8787 8888); a new image applies to new containers.

The UI's own dev server is **http://localhost:5176**. The iframe goes straight
to celld at **http://p<port>-<sessionId>.localhost:8093/**, not through Vite's
API proxy. Host routing preserves absolute asset paths, app `/api` routes,
and WebSocket upgrades for HMR. This is a local, plain-HTTP preview: celld
must be on the browser's machine. App framing restrictions (CSP or
X-Frame-Options) are preserved; use the new-tab link if embedding is blocked.

Run `node workspace.check.js` in `worker/` for proxy/port checks without a container. On a
running stack, also check absolute assets in the Network tab, edit a source
file to confirm HMR, and switch sessions/reload the UI to check port recall.
Try port 3000 and 65536 directly in the preview host: both should return 400.

## Terminal

The panel's Terminal view uses ghostty-web and `GET /api/session/:id/terminal`
(WebSocket). It attaches to a dedicated SDK session, `terminal-<id>`, in the
same sandbox as the agent, initially in the repo's cwd (or `/workspace`).
Reconnects and other browsers attach to that same shell; terminal `exit`
doesn't kill the agent's exec shell. A dropped connection retries up to ten
times with backoff; the toolbar button retries manually. An explicit shell
exit or PTY error stops automatic retries.

The view fits after Trellis attaches and sizes it. App theme changes recreate
the renderer and reattach to the shell: ghostty-web 0.4.0 cannot fully update
WASM theme colors in place. Reconnection uses the SDK's PTY buffer replay,
not a separately persisted terminal transcript.

Browser smoke test (after deploying the worker and starting the UI):

1. Open Terminal in a repo session; check `pwd`, typing, paste, Unicode,
   ANSI colors, and Ctrl-C. Try a session without a repo too.
2. Run `stty size`; resize, dock, hide/show, and switch tabs. Check that the
   first render isn't blank and a full-screen program fits the new size.
3. Switch light/dark themes and reconnect; check that the shell's cwd and
   variables survive. Disconnect/reconnect the network and watch the status.
4. Run `exit`, then use Reconnect. Send the agent a bash task to confirm its
   shell still works. Switch sessions and check that output doesn't leak.

Offline checks, in `worker/`: `node workspace.check.js` (the shell, with an
in-memory sandbox) and `node --experimental-vm-modules assets.check.mjs` (the route).
They do not test celld's upgrade transport or the container's PTY
implementation.

## Notes

- **Runtime shims** (`worker/src/index.js`): pi-ai's OAuth flows are registered
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
