# Session WebSocket protocol

This document specifies the JSON protocol spoken on `/api/session/{id}/ws`—the WebSocket that streams a Session's agent events to clients and accepts commands to drive it. The [API reference](api-reference.html) (generated via `pnpm reference`) covers the REST endpoints and lists this path only as a WebSocket upgrade (`sessionSocket` in [`packages/client/openapi.json`](../packages/client/openapi.json)).

**[`packages/client/src/protocol.ts`](../packages/client/src/protocol.ts) is the canonical definition**: `SessionCommand` defines client-to-cell messages and `SessionFrame` defines cell-to-client messages. If this page and `protocol.ts` ever disagree, `protocol.ts` is authoritative. The Session cell ([`apps/worker/src/session.js`](../apps/worker/src/session.js), `Session.commands`) implements exactly `SESSION_COMMANDS`, enforced by [`apps/worker/protocol.check.mjs`](../apps/worker/protocol.check.mjs). The reference client is [`packages/client/src/session-client.ts`](../packages/client/src/session-client.ts).

## Connect

Open a WebSocket to `ws://` or `wss://` at `/api/session/{id}/ws` on the API host (`sessionSocketUrl(base, id)` in `@boxen/client` builds this URL from an HTTP(S) base). Requests without `Upgrade: websocket` receive HTTP `426`. There is no authentication yet.

- Every message in both directions is a single JSON object containing a string `type` field.
- The cell silently ignores messages that are not valid JSON or whose `type` is not in `SESSION_COMMANDS`.
- The cell sends nothing until the client sends `sub` (Safari drops frames sent during the upgrade handshake).
- The worker does not verify that `{id}` exists before upgrading: an unknown Session ID opens a socket whose `sub` is never answered, so clients should bound how long they wait for `ready`.

## Join sequence

```text
client → sub
cell   → meta      Session metadata (REST Session schema)
cell   → events    [snapshot]
cell   → ready     Join complete; the client may send commands
cell   → events    Batches of deltas (one per commit) while connected
```

- Always build client state from the join's `snapshot` rather than merging it into state from an earlier connection.
- Send `sub` on every new socket, including reconnects.
- When the cell replaces a `Harness` poisoned by a failed commit, it closes all connected WebSockets with close code `4000` (`"session reopened"`). Clients should reconnect, send `sub`, and resume from the fresh snapshot.
- The reference `sessionClient` reconnects 2 seconds after any drop and sends `ping` every 25 seconds while open.

## Commands (`SessionCommand`)

Field definitions live in `SessionCommand` ([`protocol.ts`](../packages/client/src/protocol.ts)). In the table below, "session client" refers to [`session-client.ts`](../packages/client/src/session-client.ts) (used by the web app, `boxen` CLI, and MCP server), which only sends commands once `ready`.

| `type` | Fields | Sent by | Cell response |
|---|---|---|---|
| `sub` | — | Every client, on each new socket | The join sequence (`meta`, `events` snapshot, `ready`, then live `events`). |
| `ping` | — | Session client (every 25 s) | None; keeps idle connections alive across proxies. |
| `prompt` | `message`, `requestId` | Session client (`prompt()`, `run()`) | `events` as the turn runs, ending in its `submission` record; or an `error` frame with the same `requestId` if refused before admission (see [Turn outcome resolution](#turn-outcome-resolution)). |
| `steer` | `message`, `requestId` | Legacy clients only | Identical to `prompt`. |
| `abort` | — | Session client (`abort()`, `run()`'s `signal`) | `events`: stops the active run and settles active and queued prompts as `unanswered` (`reason: "aborted"`). |
| `configure` | `model?`, `thinkingLevel?` | Session client (`configure()`) | `events` (`agent_changed`); takes effect on the next model request. |
| `models` | — | Session client (`listModels()`) | A `models` frame sent to this socket only. |
| `rename` | `name` | External clients only | Broadcasts a `meta` frame to every joined socket (same behavior as `PATCH /api/session/{id}` with `{ "name" }`). |

### Command details

- **`prompt` and `requestId` deduplication**: Sending `prompt` while idle starts a run; sending it while a run is active queues it as a steer that joins the run at its next boundary (after the current tool round, or before the run would finish), together with every other queued prompt (`steeringMode: "all"`). `requestId` is a client-generated unique ID (UUID in `sessionClient`): resending with the same `requestId` matches the original submission instead of creating a duplicate, and both the submission record and any refusal `error` frame echo it.
- **Prompts left queued when a run stops or fails**: A run that ends without reaching a boundary (abort, model error, missing model, or fault) does not place prompts queued behind it, leaving them in the `pi-durable` inbox. Once the cell observes the agent idle—or when the Session next opens—it withdraws any leftover queued prompts (`status: "unanswered"`, `reason: "aborted"`). If a new prompt reaches the idle Session first, it pulls all queued prompts into one combined run, and each submission's record points to that run's answer. Withdrawn prompts are never answered; resend them if they still apply.
- **`abort`**: Stops the Session's current run. Active prompts and prompts already queued when the abort lands settle as `unanswered` with `reason: "aborted"`. Any prompt admitted while the run winds down is withdrawn the same way once the run ends.
- **`configure`**: Updates `model` and/or `thinkingLevel` starting from the next model request. An in-flight model request keeps its original model, but because a turn issues a new request after each tool round, configuration changes can take effect mid-turn.
- **`steer`**: Legacy alias for `prompt`. The cell handles it identically, though `sessionClient` never sends it.
- **`rename`**: Trims `name` and requires 1–120 characters (otherwise returns an `error` frame). A manual rename overrides an in-flight automatic title. `sessionClient` never sends `rename`; the web app uses `PATCH /api/session/{id}`.
- **Unsubscribed sockets**: The cell still executes commands received before `sub`, but an unsubscribed socket only receives `models` and `error` frames.

## Frames (`SessionFrame`)

Field definitions live in `SessionFrame` ([`protocol.ts`](../packages/client/src/protocol.ts)).

| `type` | Fields | When sent |
|---|---|---|
| `meta` | `meta` | During each join, and broadcast to every joined socket after any metadata change (rename, archive, or restore via WebSocket or REST). Because a join's `meta` can race a concurrent update, always keep the frame with the higher `metadataRevision`. |
| `events` | `events` | Wraps `pi-durable`'s `watchEvents` stream: a `[snapshot]` array first on join, followed by batches of deltas. |
| `ready` | — | Immediately after the join's initial `meta` and `snapshot`; signals that the client may send commands. |
| `models` | `models` | Response to `models`: available models from connected providers, each with its supported `thinkingLevels`. |
| `error` | `error`, `requestId?` | The cell failed a command (not an agent event). Includes `requestId` **only** when refusing a `prompt` prior to admission (Harness failed to open or submission failed). Post-admission failures (such as auto-titling) and failures of other commands omit `requestId`. |

### `events` payload

The objects inside `events` are `pi-durable` events:

- **`snapshot`**: Committed transcript entries, active run state (`run.inputs`), queued `inbox` items, active streaming generation/tool slots, and current agent model configuration.
- **Deltas**: Incremental events such as `message_start`, `message_update`, `message_end`, `tool_execution_*`, `run_start`, `run_end`, `agent_changed`, and `submission`.

[`packages/client/src/events.ts`](../packages/client/src/events.ts) shows how the client folds these events into a transcript model.

A `snapshot` can also arrive mid-stream: if a slow watcher falls behind, `pi-durable` drops missed delta batches and emits a fresh `snapshot`, which should replace the client's view just like a join snapshot.

## Turn outcome resolution

A prompt is settled by a `pi-durable` `submission` event whose `record.requestId` matches the prompt's `requestId`:

| `record.status` | Meaning |
|---|---|
| `queued` or `placed` | Still in progress (not settled). Every record carries the submission's `record.id`. |
| `done` | Answered. `record.answer` is the ID of the committed assistant entry holding the reply (delivered earlier in a `message_end` event's `entry` or a `snapshot`'s `entries`). Always look up the answer by this ID rather than reading the last transcript line, which another client's prompt or note may follow. |
| `unanswered` | If `record.reason` is `"aborted"`, either an `abort` stopped the run or the prompt was withdrawn after the run it was queued behind ended. Any other reason (`no_model`, `model_error`, `faulted`, `reset`, with optional `record.detail`) indicates a turn failure. |

Other termination cases:

- **Refused before admission**: An `error` frame carrying the prompt's `requestId` means the cell rejected the prompt and the turn never started. An `error` frame without a matching `requestId` is unrelated and does not settle the prompt.
- **Unknown outcome**:
  - If the socket drops after the prompt was sent, the outcome is unknown: the cell continues running the turn durably, but a rejoin's `snapshot` carries no historical submission records.
  - If a mid-turn `snapshot` arrives and no longer lists the submission's `record.id` in `run.inputs` or `inbox` (or no submission record had arrived yet), its settlement event may have been dropped, so the outcome is also unknown.

`run()` in [`packages/client/src/session-client.ts`](../packages/client/src/session-client.ts) implements this resolution logic; see [Run a turn from Node](automation.md#run-a-turn-from-node) for its `TurnResult` outcomes.
