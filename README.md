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

- **Session cell** (`src/session.js`): opens a Harness on `CellSqlite`
  (`src/cell-sqlite.js`, pi-durable's SQLite facade over `storage.sql`).
  Transcript, streamed partials, tool output, and the queue are committed
  there, so a restart resumes mid-turn. Each WebSocket gets its own
  `watchEvents()` stream (a snapshot, then deltas), which replaces the old
  event log and replay. A prompt sent while the agent works becomes a steer.
- **Sandbox** (`@cloudflare/sandbox`, image in `Dockerfile`): one Linux
  container per session. `src/sandbox-env.js` maps pi-durable's
  `ExecutionEnv` onto it: read, write, edit, and bash with streamed output.
  Container disk is ephemeral: the transcript survives a restart, but
  `/workspace` does not.
- **Directory cell**: the session list, plus model providers. Any pi-ai
  provider can take an API key or its own sign-in (Providers, bottom of the
  sidebar); credentials live here (`src/credentials.js` is the pi-ai
  `CredentialStore`), never copied from the host's pi. OAuth sign-ins
  redirect to loopback ports, which `ui/vite.config.ts` forwards to the cell;
  pasting the redirect address is the fallback from another machine.
- **Artifacts cell**: what the agent's `artifact` tool shows in the panel
  (markdown, html, svg, mermaid, code), versioned and full-text searchable,
  readable while sandboxes sleep.
- **ui/**: chat beside a resizable, dockable panel (Trellis) with Artifacts,
  Changes, Preview, Terminal, and Events views. The reducer
  (`src/lib/events.ts`) folds pi-durable agent events; run
  `node events.check.ts` from `ui/` to check it.
- **Repos**: a session can start from a repo URL; the cell clones it into the
  sandbox (again if the container lost its disk). `GH_TOKEN` and
  `LINEAR_API_KEY` from a gitignored `.env` go into each sandbox command's
  env, and the prompt includes the repo's AGENTS.md.

## What went away

| pi-sessions | here |
|---|---|
| `pi-host/server.mjs`: process supervisor, JSONL framing, batched ingest | the Harness in the cell |
| `events` table, replay, synthetic `user_prompt`/`host_*` events | `watchEvents()` snapshot + deltas |
| agent works on your real files | agent works in a per-session container |

## Run it

Needs a Docker daemon (`orbctl start`) and celld ≥ 0.5 for containers. This
prototype uses `~/.local/bin/celld-0.6.1`; the other prototypes stay on 0.3.0.

```sh
npm install && npm run deploy   # bundles the worker, saves the sandbox image to the bucket
./start.sh                      # rustfs (:9000) + celld (:8093) + .env tokens
npm run ui                      # http://localhost:5176
```

After editing `src/`, run `./deploy.sh`. 0.6.1 nodes pick up a new version
in about 15 seconds without a restart, so sandboxes keep their disks.

## Preview

Start the session's app in its sandbox, listening on `0.0.0.0` (for example,
Vite with `npm run dev -- --host 0.0.0.0 --port 5173`). In the panel's Preview
view, enter its port and press Go/Enter, or use **Find listening ports** and
pick one. The last applied port is saved per session in localStorage; reload
remounts the iframe, and the adjacent link opens the same URL in a new tab.
Ports must be 1024–65535 except **3000**, the Sandbox control server; run Next
on e.g. 3001 instead. On macOS celld can only reach ports the image declares
with `EXPOSE` (see `Dockerfile`: 3001 4000 4173 4321 5000 5173 5174 8000 8080
8787 8888); a new image applies to new containers.

The UI's own dev server is **http://localhost:5176**. The iframe goes straight
to celld at **http://p<port>-<sessionId>.localhost:8093/**, not through Vite's
API proxy. Host routing preserves absolute asset paths, app `/api` routes,
and WebSocket upgrades for HMR. This is a local, plain-HTTP preview: celld
must be on the browser's machine. App framing restrictions (CSP or
X-Frame-Options) are preserved; use the new-tab link if embedding is blocked.

Run `node preview.check.js` for proxy/port checks without a container. On a
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

Offline route checks: `node --experimental-vm-modules terminal.check.mjs`.
These mock the SDK/Harness boundaries; they do not test celld's upgrade
transport or the container's PTY implementation.

## Notes

- **Runtime shims** (`src/index.js`): pi-ai's OAuth flows are registered
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
