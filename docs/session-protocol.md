# The Session WebSocket protocol

The JSON messages on `/api/session/{id}/ws`, the socket that drives one
Session: its agent's events one way, the commands that steer it the other.
The [API reference](api-reference.html) (built by `pnpm reference`) covers the
REST surface and lists this path only as an upgrade (`sessionSocket` in
[`openapi.json`](../packages/client/openapi.json)).

**[`packages/client/src/protocol.ts`](../packages/client/src/protocol.ts) is
the definition**: `SessionCommand` is what a client sends, `SessionFrame` what
the cell sends back, with their field types. This page explains them; where it
and `protocol.ts` disagree, `protocol.ts` is right. The Session cell
([`apps/worker/src/session.js`](../apps/worker/src/session.js), `Session.commands`)
handles exactly `SESSION_COMMANDS`, and
[`apps/worker/protocol.check.mjs`](../apps/worker/protocol.check.mjs) fails
when the two disagree. The client that speaks it is
[`session-client.ts`](../packages/client/src/session-client.ts).

## Connect

Open a WebSocket to `ws://` or `wss://` on the API's host, path
`/api/session/{id}/ws`; `sessionSocketUrl(base, id)` in the client builds it
from the API's base URL. A request without `Upgrade: websocket` gets 426.
There is no auth yet.

Every message, both ways, is one JSON object with a string `type`. The cell
ignores a message that isn't JSON or whose `type` is not a command, without
answering.

The cell sends nothing until the client sends `sub` (Safari drops frames sent
during the upgrade). The worker does not check that the Session exists before
upgrading: for an unknown id the socket opens and `sub` is never answered, so
bound the wait for `ready`.

## The join

```
client → sub
cell   → meta      the Session, as the REST API's Session schema
cell   → events    [snapshot]
cell   → ready     the join is complete
cell   → events    batches of deltas, one per commit, for as long as the socket lives
```

Build the client's view from the join's snapshot, not by merging it into what
an earlier connection showed. Send `sub` again on every new socket. The cell
closes every socket (code 4000, "session reopened") when it replaces a
Harness that a failed commit poisoned; reconnect and rejoin, and the new
snapshot carries on. The session client retries 2 s after any drop and sends
`ping` every 25 s while open.

## Commands

Fields and their types are in `SessionCommand`. "The session client" is
[`session-client.ts`](../packages/client/src/session-client.ts), which the web
app, `pds` and the MCP server all use; it sends commands only once `ready`.

| `type` | fields | sent by | answered by |
|---|---|---|---|
| `sub` | | every client, on each new socket | the join above |
| `ping` | | the session client, every 25 s | nothing: traffic on an idle socket for the proxies on the way |
| `prompt` | `message`, `requestId` | the session client (`prompt()`, `run()`) | `events` as the turn runs, ending in its submission record; an `error` frame with the same `requestId` if the cell refuses it (see [a turn's outcome](#a-turns-outcome)) |
| `steer` | as `prompt` | old clients only | as `prompt`: the cell handles it as one |
| `abort` | | the session client (`abort()`, `run()`'s signal) | `events`: the run stops, and its prompts, with any queued behind it, settle `unanswered` with reason `aborted` |
| `configure` | `model?`, `thinkingLevel?` | the session client (`configure()`) | `events` (`agent_changed`); applies from the next model request: the request in flight keeps its model, but a turn makes a new request after each tool round, so a turn can change model partway |
| `models` | | the session client (`listModels()`) | a `models` frame, to this socket only |
| `rename` | `name` | other clients only | a `meta` frame to every joined socket, as after `PATCH /api/session/{id}` with `{ "name" }` |

- **`prompt`** while the agent is idle starts a run; while it works, the
  message is queued as a steer and joins the run at its next boundary (after
  the current tool round, or before the run would end). `requestId` is the client's own unique
  id for this prompt (the session client uses a UUID): a resend with the same
  `requestId` finds the first submission instead of making a second, and the
  turn's records and refusal carry it.
- **`steer`** is `prompt`'s old name. The cell still accepts it and does
  exactly what `prompt` does; the session client never sends it.
- **`rename`** is handled by the cell, which renames the Session as the REST
  `PATCH` does (the name is trimmed and must be 1 to 120 characters, else an `error`
  frame; it wins over an automatic title still being generated). The session client never sends it;
  the web app renames through `PATCH /api/session/{id}`.
- The cell handles a command on a socket that has not sent `sub`, but such a
  socket receives only `models` and `error` frames.

## Frames

Fields and their types are in `SessionFrame`.

| `type` | fields | when |
|---|---|---|
| `meta` | `meta` | in each join, and to every joined socket after each metadata change (rename, archive or restore, by command or REST). A join's `meta` can race a change's; keep the one with the higher `metadataRevision`. |
| `events` | `events` | pi-durable's `watchEvents` stream, as it is: a `snapshot` first in each join, then batches of deltas |
| `ready` | | the join is complete; the client can send commands |
| `models` | `models` | the answer to `models`: the models the connected providers make available, each with its thinking levels |
| `error` | `error`, `requestId?` | the cell failed a command. `requestId` only when it refused that prompt (before admitting it: the Harness would not open, or the submission failed). Failures after admission (the automatic title) and of other commands carry none. Not an agent event. |

The events inside `events` are pi-durable's, not this repo's: the snapshot
(committed entries, the run in progress and the inbox, the streaming
generation and tool slots, the agent's model) and deltas such as
`message_start`, `message_update`, `message_end`, `tool_execution_*`,
`run_start`, `run_end`, `agent_changed` and `submission`.
[`events.ts`](../packages/client/src/events.ts) is how the client folds them
into a transcript. A `snapshot` can also arrive mid-stream: when a watcher
falls behind, pi-durable replaces the batches it dropped with a fresh
snapshot, which replaces the view as a join's does.

## A turn's outcome

A prompt is settled by a pi-durable `submission` event whose `record.requestId`
is the prompt's:

- `record.status` `queued` or `placed`: not settled yet. Every record carries
  the submission's id (`record.id`).
- `done`: answered. `record.answer` is the id of the committed entry holding
  the answer (it arrived earlier, in a `message_end` event's `entry` or a
  snapshot's `entries`). Read the answer there, not from the transcript's last
  line, which another client's prompt can follow.
- `unanswered`: `record.reason` `aborted` means someone sent `abort`; any
  other reason (`no_model`, `model_error`, `faulted`, `reset`, with
  `record.detail` when there is one) means the turn failed.

An `error` frame carrying the prompt's `requestId` means the cell refused it,
and the turn never started. An `error` frame without one is not this prompt's
outcome.

If the socket drops after the prompt went out, the outcome is unknown: the
cell runs the turn on, but a rejoin's snapshot carries no submission records.
If a snapshot arrives mid-turn and no longer lists the submission's id in
`run.inputs` or `inbox`, its record may have been among the dropped batches,
so the outcome is unknown then too. `run()` in
[`session-client.ts`](../packages/client/src/session-client.ts) implements
exactly this; the README's [Run a turn from Node](../README.md#run-a-turn-from-node)
lists its results.
