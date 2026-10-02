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
- **Directory cell**: the session list as before, plus the model login and
  default model (`src/credentials.js` is the pi-ai `CredentialStore`).
  `start.sh` seeds both from `~/.pi/agent`.
- **ui/**: unchanged apart from the reducer (`src/lib/events.ts`), which now
  folds pi-durable agent events. Run `node events.check.ts` from `ui/` to check it.

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
./start.sh                      # rustfs (:9000) + celld (:8093) + auth seed
npm run ui                      # http://localhost:5176
```

After editing `src/`, run `./deploy.sh`. 0.6.1 nodes pick up a new version
in about 15 seconds without a restart, so sandboxes keep their disks.

## Notes

- **OAuth refresh.** The cell holds its own copy of your `~/.pi/agent/auth.json`
  login. OpenAI rotates refresh tokens, so whichever side refreshes first
  (host pi or the cell) leaves the other with a spent token. Re-login on the
  host, then `./start.sh --force-auth`.
- **Runtime shims** (`src/index.js`): pi-ai's OAuth flows are registered
  statically (`registerBunOAuthFlows`), and `atob` is patched to accept
  unpadded base64url JWTs.
- **Prompt.** A one-line preamble plus the cwd. No AGENTS.md, skills, or MCP:
  pi-durable's `CodingTools` are just the four tools.
- celld builds images for `linux/amd64` by default, so on Apple silicon the
  sandbox runs under emulation (`CELLD_CONTAINER_PLATFORM` overrides it; untried).
