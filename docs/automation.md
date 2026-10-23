# Drive boxen from scripts and agents

## Drive it from the command line

`boxen` (`apps/cli/`) is the system's one command line. From the workspace, run
`pnpm boxen <command>` or `node apps/cli/boxen.ts <command>`:

```sh
pnpm boxen list                                   # id, status, name per line
id=$(pnpm boxen create --repo https://github.com/you/repo.git)   # prints the new id
pnpm boxen prompt "$id" "List the files in /workspace"           # streams the reply
pnpm boxen prompt "$id" "And now?" --json         # {"status":"done","text":"…"}
pnpm boxen help
```

It talks to `--url`, else `$BOXEN_URL`, else `http://127.0.0.1:8093` (a tailnet
URL works the same). `--json` makes any command print one JSON value on
stdout: the API's Session list or new Session, or the turn's result below
(nothing while the reply streams). Diagnostics go to stderr. Exit codes: 0 on
success (for `prompt`, only a `done` turn), 1 on failure (an API error, or a
turn that ended any other way), 2 for bad usage. Ctrl-C aborts the turn; with no connection in 15 s it gives up. A
prompt spends model credits, and the Session stays behind. There is no auth
yet; `system()` in `packages/client/src/index.ts`, which `boxen` and the MCP
server share, is where a credential will attach.

The operations commands of #68 (start, stop, deploy, status, logs) will join
the same binary as a second group in its command table; see the comment above
`groups` in `apps/cli/boxen.ts`.

`boxen` is written by hand on purpose: [docs/forge-evaluation.md](forge-evaluation.md)
ran Cloudflare's forge generator against `openapi.json` (2026-10-04) and
recommends against generating it for now, with the condition that would
change that.

## Drive it from another agent (MCP)

`apps/mcp/server.ts` is an MCP server on stdio, so an agent such as Claude
Code can use Sessions as tools. Like `boxen`, it talks to `$BOXEN_URL`, else
`http://127.0.0.1:8093`, through the shared client, with no auth yet.

| Tool | Arguments | Returns |
|---|---|---|
| `list_sessions` | | the API's Session list, as JSON |
| `create_session` | `name?`, `repo?`, `branch?` | the new Session, as JSON |
| `run_turn` | `session`, `prompt` | the answer's text once the turn ends; any other outcome as an error saying what happened and what to do |
| `list_artifacts` | `session?` (all Sessions when omitted) | artifact summaries, as JSON |
| `search_artifacts` | `query` | the best matches, with a snippet each, as JSON |
| `read_artifact` | `artifact`, `version?` | the details as JSON, then the content verbatim |

`run_turn` reports progress when the caller asks for it (a progress token):
one notification when the Session has joined and the prompt went out, one per
tool call as it starts (its name and arguments), and one per piece of text the
agent finishes, each clipped to 120 characters. Cancelling the call aborts the
Session's whole current run, as the web app's stop button does; if the
Session does not confirm the abort within 5 s, the server stops waiting and
closes its connection. The server shuts down when its stdin ends or on
SIGTERM or SIGINT, aborting a running turn first. A turn whose connection
drops comes back as "outcome unknown", with how to find out.

Register it with Claude Code (use the absolute path of your checkout; leave
out `-e` for the default address):

```sh
claude mcp add boxen -e BOXEN_URL=http://127.0.0.1:8093 -- node /path/to/boxen/apps/mcp/server.ts
```

or, for everyone working in a project, in its `.mcp.json` (Claude Code fills
in `${BOXEN_URL:-…}` from the environment it starts in):

```json
{
  "mcpServers": {
    "boxen": {
      "command": "node",
      "args": ["/path/to/boxen/apps/mcp/server.ts"],
      "env": { "BOXEN_URL": "${BOXEN_URL:-http://127.0.0.1:8093}" },
      "timeout": 1800000
    }
  }
}
```

A turn can outlast an MCP client's tool timeout, and a client that times a
call out cancels it, which aborts the turn. In Claude Code the per-server
`timeout` above (milliseconds; the `MCP_TOOL_TIMEOUT` environment variable
sets it for every server) is a hard limit that progress does not extend, so
set it to the longest turn you will wait for. `node apps/mcp/mcp.check.ts`
drives every tool through the MCP protocol with no backend.

## Run a turn from Node

The shared client drives a Session with no browser; `apps/cli/boxen.ts`
(`prompt`) is a complete caller, including the streaming printer.

In code: `sessionClient(sessionSocketUrl(base, id), { transport: webSocketTransport })`, `connect()`,
then `await client.run(text, { signal })`. It waits for the join, sends the
prompt, and resolves when the cell settles that prompt (its pi-durable
submission record, matched by requestId) with one of:

| `status` | when | the turn in the cell |
|---|---|---|
| `done` (`text`: the answer's text) | the prompt was answered | finished |
| `error` (`error`: the reason) | the cell refused the prompt (an `error` frame carrying its requestId), or settled it unanswered (no model, model error, fault) | never started, or ended |
| `aborted` | anyone's `abort`, including this call's `signal`; or the prompt was queued behind a run that ended before it joined (an abort, a model error), so the cell withdrew it | stopped, or never started |
| `disconnected` (the outcome is unknown) | the socket dropped after the prompt went out, or the cell dropped events mid-turn | **may still be running** |

Progress is the client's state: `subscribe()` and read the reply growing in
`state().model.items`. The `signal` sends nothing if the prompt hasn't gone
out yet; otherwise it sends `abort`, and `run()` resolves when the cell
settles the turn, normally `aborted`. A drop before the prompt goes out only
delays it (the socket keeps retrying; abort the signal if `ready` hasn't come
after a while, as `boxen prompt` does, to bound the wait without bounding the
turn). A drop after resolves `disconnected` at once instead of following
the turn through the reconnect: the cell runs it on durably, but a rejoin's
snapshot carries no submission records, so `run()` couldn't tell how a turn
that ended meanwhile was settled. The caller decides: look at the Session later, or
abort it. Stopping the client (the function `connect()` returned) settles a
pending `run()` too: `disconnected` if its prompt went out, `aborted` if not.
`run()` never resends.

The cell can also drop events: when a watcher falls behind, pi-durable
replaces the batches it dropped with a fresh snapshot. If that snapshot still
lists the prompt's submission in the run or the inbox, `run()` keeps waiting
(and finds the answer among the snapshot's entries if it is there). If not,
or if no record for the prompt had arrived yet, the settlement may have been
dropped, and `run()` resolves `disconnected` rather than wait for a record
that won't come.

`text` is the answer entry the cell records for this prompt, not the last
line of the transcript, so other callers' prompts and error lines can't cut
it short. Error frames without the prompt's requestId (a failed automatic
title, another command's failure) show in the transcript but don't end the
turn. A worker deployed before the cell named refusals sends them without
one, so `run()` against it waits on a refused prompt until stopped: deploy
the worker with the client. `packages/client/session.check.ts` covers
every outcome with the scripted socket.

