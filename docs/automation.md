# Drive boxen from scripts and agents

boxen exposes three headless interfaces backed by the shared `@boxen/client` package:

- **CLI (`boxen`)**: list Sessions, create Sessions, and stream prompts from a terminal or shell script.
- **MCP server**: expose Sessions and artifacts as tools for another agent such as Claude Code.
- **Node TypeScript client**: embed REST and WebSocket turn execution directly in scripts or services.

None of these interfaces require authentication yet; requests flow through `system()` in [`packages/client/src/index.ts`](../packages/client/src/index.ts), where credentials will attach in the future.

## CLI (`boxen`)

The CLI lives in [`apps/cli/boxen.ts`](../apps/cli/boxen.ts). Run it from the workspace with `pnpm boxen <command>` or `node apps/cli/boxen.ts <command>`:

```sh
pnpm boxen list
id=$(pnpm boxen create --repo https://github.com/you/repo.git)
pnpm boxen prompt "$id" "List the files in /workspace"
pnpm boxen prompt "$id" "Summarize what you found" --json
pnpm boxen help
pnpm boxen --version
```

### Commands

| Command | Arguments | Description |
|---|---|---|
| `list` | — | List Sessions, most recently active first (tab-separated `id`, `status` or `archived`, `name`). |
| `create` | `[--name <name>] [--repo <git-url>] [--branch <branch>]` | Create a new Session and print its `id`. |
| `prompt` | `<session-id> <text...>` | Send a prompt, stream the assistant's reply to stdout, and exit `0` when the turn settles as `done`. |
| `help` | — | Print usage information (also `-h`, `--help`). |
| `--version` | — | Print the local CLI version (not the running server version). |

### Flags and environment

| Option / Variable | Scope | Description |
|---|---|---|
| `--url <url>` | All commands | Server base URL (`http://` or `https://`). Overrides `$BOXEN_URL` and the default `http://127.0.0.1:8093`. Tailnet URLs work identically. |
| `BOXEN_URL` | Environment | Default server URL when `--url` is omitted (falls back to `http://127.0.0.1:8093`). |
| `--json` | All commands | Print one JSON value on stdout: the Session array (`list`), the created Session (`create`), or the `TurnResult` object (`prompt`, suppressing incremental streaming). Diagnostics always go to stderr. |
| `-h`, `--help` | All commands | Print usage help and exit `0`. |
| `--name <name>` | `create` | Display name for the Session. If omitted, the Session starts from the repo name (or `untitled`) and is auto-titled from its first prompt. |
| `--repo <git-url>` | `create` | Git repository URL to clone into `/workspace/<repo>` before the first turn. |
| `--branch <branch>` | `create` | Branch to check out when cloning `--repo` (defaults to the repository's default branch). |

### Exit codes and runtime behavior

| Exit code | Meaning |
|---|---|
| `0` | Success (for `prompt`, only when the turn ends with `status: "done"`). |
| `1` | Runtime failure: API or network error, connect timeout, or a `prompt` turn that ended as `error`, `aborted`, or `disconnected`. |
| `2` | Bad usage: unknown command, invalid flag, missing required argument, or non-`http(s)` URL. |

- **Connect timeout**: `boxen prompt` waits up to **15 seconds** for the Session WebSocket to join (`ready`). If it cannot connect in time, nothing is sent and the command exits `1`. Once connected, the turn itself has no timeout.
- **Cancellation (`Ctrl-C`)**: The first `SIGINT` sends `abort` to stop the running turn cleanly; a second `Ctrl-C` terminates the process immediately.
- **Side effects**: `prompt` spends model credits, and created Sessions remain on the server.

> **Note:** `boxen` is maintained by hand rather than generated from `openapi.json`. See [docs/forge-evaluation.md](forge-evaluation.md) for the evaluation of Cloudflare's `forge` generator and the criteria that would change that decision.

## MCP server

[`apps/mcp/server.ts`](../apps/mcp/server.ts) is a stdio Model Context Protocol (MCP) server that lets another agent (such as Claude Code or `pi`) manage boxen Sessions, run turns, and inspect artifacts. Like the CLI, it connects via `$BOXEN_URL` (defaulting to `http://127.0.0.1:8093`) through `@boxen/client`.

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `list_sessions` | — | JSON array of all Sessions, most recently active first (`id`, `name`, `status`, `repo`, `branch`, `createdAt`, `lastActivity`, `archivedAt`). |
| `create_session` | `name?`, `repo?`, `branch?` | The newly created Session as JSON (`id`, `name`, `cwd`, `repo`, `branch`, `createdAt`). |
| `run_turn` | `session`, `prompt` | The agent's final reply text when the turn completes. Any non-`done` outcome returns an MCP tool error explaining what happened and what to check next. |
| `list_artifacts` | `session?` | JSON array of artifact summaries without content, newest first (filtered to one Session if provided, or up to 200 across all Sessions). |
| `search_artifacts` | `query` | Up to 50 full-text matches across all Sessions' titles and contents as JSON, each with a `[bracketed]` snippet. |
| `read_artifact` | `artifact`, `version?` | Two content blocks: metadata JSON first, followed by the artifact's verbatim content (latest version unless `version` is specified). |

### Progress, cancellation, and timeouts

- **Progress notifications**: When the caller supplies a `progressToken`, `run_turn` emits `notifications/progress` events for key milestones rather than every token:
  1. Once when the Session joins and the prompt is sent (`connected to the Session; prompt sent`).
  2. Once per tool call as it starts (tool name and arguments).
  3. Once per finished assistant text block.

  Each progress message is whitespace-normalized and clipped to 120 characters.
- **Connect timeout**: If the Session does not join within **15 seconds**, `run_turn` returns an error without sending the prompt.
- **Cancellation and shutdown**: Cancelling a `run_turn` request sends `abort` to the Session—stopping the Session's entire current run, just like the web app's Stop button. If the Session does not confirm the abort within **5 seconds**, the server stops waiting and closes the socket. Closing stdin, `SIGTERM`, or `SIGINT` shuts the server down after aborting any in-flight turn.
- **Dropped connections**: If the socket drops after the prompt was sent, `run_turn` returns an `"Outcome unknown"` error rather than resending, instructing the caller to check `list_sessions` (`running` vs `idle`) before taking further action.

### Claude Code setup

Register the server for your user profile (replace `/path/to/boxen` with the absolute path to your checkout; omit `-e` to use the default address):

```sh
claude mcp add boxen -e BOXEN_URL=http://127.0.0.1:8093 -- node /path/to/boxen/apps/mcp/server.ts
```

Or check a shared configuration into a project's `.mcp.json` (Claude Code expands `${BOXEN_URL:-…}` from its startup environment):

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

> **Timeout tip:** Agent turns can take several minutes. When an MCP client times out a tool call, it cancels the request—which aborts the running turn in boxen. In Claude Code, both per-server `timeout` (milliseconds) and the global `MCP_TOOL_TIMEOUT` environment variable are hard limits that progress notifications do not extend, so set `timeout` to the longest turn you are willing to wait for.

Run `node apps/mcp/mcp.check.ts` to verify every MCP tool end-to-end over the MCP protocol without a running backend.

## Run a turn from Node

`@boxen/client` drives Sessions directly from Node without a browser. Use `system(url, { transport: webSocketTransport })` to access both the REST API and Session clients (or construct a standalone client directly with `sessionClient(sessionSocketUrl(url, id), { transport: webSocketTransport })`).

```ts
import { system, webSocketTransport } from "@boxen/client";

const { session } = system("http://127.0.0.1:8093", { transport: webSocketTransport });
const client = session(sessionId);

const unsubscribe = client.subscribe(() => {
  const { model } = client.state();
  // Inspect live transcript items growing in model.items
});

const stop = client.connect();
try {
  const result = await client.run("List the files in /workspace", { signal });
  if (result.status === "done") {
    console.log(result.text);
  } else {
    console.error("Turn did not complete:", result);
  }
} finally {
  unsubscribe();
  stop();
}
```

See [`apps/cli/boxen.ts`](../apps/cli/boxen.ts) (`prompt`) for a complete caller including incremental stdout streaming and a connect timeout.

`client.run(text, { signal })` waits until the socket finishes joining (`ready`), sends the prompt with a unique `requestId`, and resolves with a `TurnResult` once the cell settles that submission:

| `status` | Payload | When it occurs | State in the Session cell |
|---|---|---|---|
| `done` | `text: string` | The prompt was answered. `text` comes from the committed assistant entry referenced by the submission record—not the last line of the transcript—so concurrent prompts or error notes cannot truncate or replace it. | Finished |
| `error` | `error: string` | The cell refused the prompt (an `error` frame carrying the prompt's `requestId`), or settled it unanswered (`no_model`, `model_error`, `faulted`, `reset`). | Never started, or ended |
| `aborted` | — | Cancelled via `signal` or another client's `abort`, or withdrawn because the run it was queued behind ended before admitting it. | Stopped, or never started |
| `disconnected` | — | The socket dropped after the prompt was sent, `stop()` was called mid-turn, or the cell dropped events and the replacement snapshot no longer lists the submission. | **May still be running** |

### Cancellation, disconnects, and snapshot resyncs

- **Cancellation (`signal`)**: Aborting `signal` before the prompt is sent resolves `aborted` immediately without sending anything. Aborting after the prompt is sent sends an `abort` command and resolves once the cell settles the turn (normally `aborted`).
- **Disconnect before send**: If the socket drops before `ready`, the client keeps retrying every 2 seconds and waits to send the prompt. To bound the connection wait without bounding the turn itself, start a timer that aborts `signal` and clear it when `client.state().ready` becomes `true`.
- **Disconnect after send**: `run()` immediately resolves `disconnected` and never resends. The Session cell continues executing the turn durably, but a reconnected socket's `snapshot` carries no historical submission records, so the client cannot know how a turn that finished during the outage settled. Inspect the Session later or abort it explicitly.
- **Stopping the client**: Calling the `stop()` cleanup function returned by `connect()` immediately settles any pending `run()`—`disconnected` if the prompt was already sent, or `aborted` if it was not.
- **Mid-turn snapshot resync**: When a slow subscriber falls behind, `pi-durable` drops missed delta batches and sends a fresh `snapshot`. If that snapshot still lists the prompt's submission in `run.inputs` or `inbox`, `run()` keeps waiting (and collects committed answer entries from the snapshot). If the submission is missing—or no submission record had arrived before the resync—the settlement may have been dropped, so `run()` resolves `disconnected`.
- **Unrelated `error` frames**: Error frames without the prompt's `requestId` (such as a failed auto-title or another command's failure) are added to the transcript but do not terminate `run()`. Deploy the worker alongside the client so prompt refusals always include `requestId`.

[`packages/client/session.check.ts`](../packages/client/session.check.ts) tests every `TurnResult` outcome against a scripted socket. For the wire-level frames and commands behind `sessionClient`, see the [Session WebSocket protocol](session-protocol.md).
