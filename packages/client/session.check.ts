// Self-check for the session client, through its interface: node session.check.ts
// A scripted socket stands in for the browser's WebSocket and a manual clock
// for timers, so drops, retries and pings run without waiting.
import assert from "node:assert/strict";
import { PING_MS, RETRY_MS, type Clock, type Transport } from "./src/socket.ts";
import { sessionClient, sessionSocketUrl, type SessionClient } from "./src/session-client.ts";

// The test adapter at the transport seam: each socket the client opens,
// driven by hand.
interface Scripted {
  url: string;
  sent: ({ type: string } & Record<string, unknown>)[];
  closed: boolean;
  open(): void;
  frame(msg: object): void;
  drop(): void;
}
function scriptedTransport() {
  const sockets: Scripted[] = [];
  const transport: Transport = (url, on) => {
    let open = false;
    const s: Scripted = {
      url, sent: [], closed: false,
      open() { open = true; on.open(); },
      frame(msg) { on.message(JSON.stringify(msg)); },
      drop() { open = false; on.close(); },
    };
    sockets.push(s);
    return {
      send(data) { if (!open) throw new Error("not open"); s.sent.push(JSON.parse(data)); },
      close() { s.closed = true; open = false; on.close(); }, // as a browser does, later
    };
  };
  return { transport, sockets, last: () => sockets[sockets.length - 1] };
}

function manualClock() {
  let now = 0;
  let timers: { at: number; every?: number; fn: () => void }[] = [];
  const add = (t: { at: number; every?: number; fn: () => void }) => {
    timers.push(t);
    return () => { timers = timers.filter((x) => x !== t); };
  };
  const clock: Clock = {
    after: (ms, fn) => add({ at: now + ms, fn }),
    every: (ms, fn) => add({ at: now + ms, every: ms, fn }),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.every; else timers = timers.filter((t) => t !== next);
      next.fn();
    }
    now = end;
  };
  return { clock, advance };
}

function setup() {
  const net = scriptedTransport();
  const time = manualClock();
  const client = sessionClient("ws://test/api/session/s1/ws", { transport: net.transport, clock: time.clock });
  const readiness = [client.state().ready];
  client.subscribe(() => {
    const { ready } = client.state();
    if (readiness.at(-1) !== ready) readiness.push(ready);
  });
  const stop = client.connect();
  return { client, net, time, readiness, stop };
}

const meta = { id: "s1", name: "untitled", cwd: "/workspace", createdAt: 1 };
const snapshot = (entries: object[], rest: object = {}) => ({ type: "snapshot", entries, tools: [], ...rest });
const join = (s: Scripted, snap: object) => {
  s.open();
  s.frame({ type: "meta", meta });
  s.frame({ type: "events", events: [snap] });
  s.frame({ type: "ready" });
};
const kinds = (c: SessionClient) => c.state().model.items.map((i) => i.kind);
const artifactCall = (id: string) => ({ type: "toolCall", id, name: "artifact", arguments: { title: "Plan" } });
const artifactResult = (callId: string, artifactId: string) =>
  ({ role: "toolResult", toolCallId: callId, content: [{ type: "text", text: "saved" }], details: { artifactId } });

// Metadata: a stale subscription snapshot never replaces a newer broadcast.
{
  const { client, net } = setup();
  const s = net.last();
  s.open();
  s.frame({ type: "meta", meta: { ...meta, name: "Renamed", metadataRevision: 2 } });
  s.frame({ type: "meta", meta: { ...meta, metadataRevision: 1 } });
  assert.equal(client.state().meta?.name, "Renamed");
  s.frame({ type: "meta", meta: { ...meta, name: "Again", metadataRevision: 3 } });
  assert.equal(client.state().meta?.name, "Again");
}

// Joining: sub on open; meta, then a snapshot that shows only at ready.
{
  const { client, net } = setup();
  const s = net.last();
  assert.equal(s.url, "ws://test/api/session/s1/ws");
  assert.deepEqual(s.sent, []);
  s.open();
  assert.deepEqual(s.sent, [{ type: "sub" }]);
  s.frame({ type: "meta", meta });
  assert.equal(client.state().meta?.name, "untitled");
  s.frame({ type: "events", events: [snapshot([{ model: [{ role: "user", content: "hi" }] }], { agent: { thinkingLevel: "high" } })] });
  assert.equal(client.state().ready, false);
  assert.deepEqual(kinds(client), [], "the snapshot waits for ready");
  assert.equal(client.prompt("too early"), false, "commands wait for ready");
  s.frame({ type: "ready" });
  assert.equal(client.state().ready, true);
  assert.deepEqual(kinds(client), ["user"]);
  assert.equal(client.state().model.agent.thinkingLevel, "high");
}

// Commands are typed and named; the model list arrives as state.
{
  const { client, net } = setup();
  const s = net.last();
  join(s, snapshot([]));
  assert.equal(client.prompt("do it"), true);
  assert.equal(client.abort(), true);
  assert.equal(client.configure({ model: { provider: "openai", modelId: "m1" }, thinkingLevel: "low" }), true);
  assert.equal(client.listModels(), true);
  assert.equal(client.prompt("do it"), true);
  // Each prompt carries its own requestId, for the cell to dedupe a resend.
  const ids = s.sent.filter((c) => c.type === "prompt").map((c) => c.requestId);
  assert.equal(ids.length, 2);
  assert.equal(typeof ids[0], "string");
  assert.notEqual(ids[0], ids[1]);
  const { requestId: _, ...first } = s.sent[1];
  assert.deepEqual([first, ...s.sent.slice(2, 5)], [
    { type: "prompt", message: "do it" },
    { type: "abort" },
    { type: "configure", model: { provider: "openai", modelId: "m1" }, thinkingLevel: "low" },
    { type: "models" },
  ]);
  const models = [{ provider: "openai", id: "m1", name: "M1", thinkingLevels: ["low"] }];
  s.frame({ type: "models", models });
  assert.deepEqual(client.state().models, models);
}

// Drop mid-turn and rejoin: ready false at once, the old transcript stays on
// screen until the new snapshot replaces it whole at ready.
{
  const { client, net, time, readiness } = setup();
  const first = net.last();
  join(first, snapshot([{ model: [{ role: "user", content: "one" }] }]));
  first.frame({ type: "models", models: [] });
  first.frame({ type: "events", events: [{ type: "run_start" }, { type: "message_start", message: { role: "assistant", content: [] } }] });
  const before = client.state().model;
  assert.equal(before.running, true);

  first.drop();
  assert.equal(client.state().ready, false);
  assert.equal(client.state().model, before, "nothing blanks while disconnected");
  // A command while disconnected is refused, not queued.
  assert.equal(client.prompt("lost?"), false);
  assert.equal(client.abort(), false);

  time.advance(RETRY_MS - 1);
  assert.equal(net.sockets.length, 1);
  time.advance(1);
  assert.equal(net.sockets.length, 2, "retries after RETRY_MS");
  const second = net.last();
  second.open();
  assert.deepEqual(second.sent, [{ type: "sub" }]);
  second.frame({ type: "meta", meta: { ...meta, name: "Renamed" } });
  second.frame({ type: "events", events: [snapshot([
    { model: [{ role: "user", content: "one" }] },
    { model: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] },
  ])] });
  assert.equal(client.state().model, before, "still the old transcript while joining");
  second.frame({ type: "ready" });
  const after = client.state().model;
  assert.notEqual(after, before);
  assert.deepEqual(kinds(client), ["user", "assistant"]);
  assert.equal(after.running, false);
  assert.equal(client.state().meta?.name, "Renamed");
  assert.deepEqual(client.state().models, [], "the model list survives a reconnect");
  assert.deepEqual(readiness, [false, true, false, true]);
  assert.deepEqual(first.sent.filter((c) => c.type === "prompt"), [], "the refused prompt never went out");
  assert.deepEqual(second.sent.filter((c) => c.type === "prompt"), [], "nor was it replayed");
  assert.equal(client.prompt("now"), true);
  // A late frame from the dead socket changes nothing.
  first.frame({ type: "meta", meta: { ...meta, name: "stale" } });
  assert.equal(client.state().meta?.name, "Renamed");
}

// A drop before the first join, and an `error` frame: the cell refusing a
// command shows as an error line, not as an agent event.
{
  const { client, net, time } = setup();
  net.last().drop();
  time.advance(RETRY_MS);
  const s = net.last();
  join(s, snapshot([]));
  const logged = client.state().model.log.length;
  s.frame({ type: "error", error: "no model configured" });
  assert.deepEqual(client.state().model.items.at(-1), { kind: "system", level: "error", text: "no model configured", seq: 0 });
  assert.equal(client.state().model.log.length, logged, "not in the Events log");
}

// Pings keep an open socket busy; nothing is sent while it is down.
{
  const { net, time } = setup();
  const s = net.last();
  join(s, snapshot([]));
  time.advance(PING_MS);
  assert.deepEqual(s.sent.at(-1), { type: "ping" });
  s.drop();
  const sent = s.sent.length;
  time.advance(PING_MS); // the retry opens a socket that never connects
  assert.equal(s.sent.length, sent);
  assert.deepEqual(net.last().sent, []);
}

// Stopping closes the socket and never reconnects, even with a retry due.
{
  const { client, net, time, stop } = setup();
  join(net.last(), snapshot([]));
  stop();
  assert.equal(net.last().closed, true);
  assert.equal(client.state().ready, false);
  time.advance(10 * PING_MS);
  assert.equal(net.sockets.length, 1);
  assert.equal(client.prompt("x"), false);

  const other = setup();
  other.net.last().drop();
  other.stop();
  other.time.advance(RETRY_MS);
  assert.equal(other.net.sockets.length, 1);
}

// A live artifact save is reported as new; one in the joining snapshot is not.
{
  const { client, net, time } = setup();
  const s = net.last();
  join(s, snapshot([
    { model: [{ role: "assistant", content: [artifactCall("c0")], stopReason: "toolUse" }] },
    { model: [artifactResult("c0", "a0")] },
  ]));
  assert.deepEqual(client.state().model.artifacts, ["a0"]);
  assert.equal(client.state().saved, null, "a save in the snapshot is not news");

  s.frame({ type: "events", events: [
    { type: "message_start", message: { role: "assistant", content: [artifactCall("c1")] } },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "artifact" },
  ] });
  assert.equal(client.state().saved, null);
  s.frame({ type: "events", events: [{ type: "tool_execution_end", toolCallId: "c1", entry: { model: [artifactResult("c1", "a1")] } }] });
  const saved = client.state().saved;
  assert.deepEqual(saved, { id: "a1" });
  assert.deepEqual(client.state().model.artifacts, ["a0", "a1"]);
  const block = (client.state().model.items.at(-1) as { blocks: { artifactId?: string }[] }).blocks[0];
  assert.equal(block.artifactId, "a1");

  // The same result again as a message neither counts twice nor reports anew.
  s.frame({ type: "events", events: [{ type: "message_start", message: artifactResult("c1", "a1") }] });
  assert.equal(client.state().saved, saved);
  assert.deepEqual(client.state().model.artifacts, ["a0", "a1"]);

  // Rejoining with both saves in the snapshot reports nothing new.
  s.drop();
  time.advance(RETRY_MS);
  join(net.last(), snapshot([
    { model: [{ role: "assistant", content: [artifactCall("c0")], stopReason: "toolUse" }] },
    { model: [artifactResult("c0", "a0")] },
    { model: [{ role: "assistant", content: [artifactCall("c1")], stopReason: "toolUse" }] },
    { model: [artifactResult("c1", "a1")] },
  ]));
  assert.equal(client.state().saved, saved);
  assert.deepEqual(client.state().model.artifacts, ["a0", "a1"]);
}

// Finished calls that may touch files are counted once each, for Changes.
{
  const { client, net } = setup();
  const s = net.last();
  const bash = { type: "toolCall", id: "b1", name: "bash", arguments: { command: "touch x" } };
  const read = { type: "toolCall", id: "r1", name: "read", arguments: { path: "x" } };
  join(s, snapshot([]));
  s.frame({ type: "events", events: [
    { type: "message_start", message: { role: "assistant", content: [bash, read] } },
    { type: "tool_execution_end", toolCallId: "r1", entry: { model: [{ role: "toolResult", toolCallId: "r1", content: "" }] } },
  ] });
  assert.equal(client.state().model.mutations, 0);
  s.frame({ type: "events", events: [{ type: "tool_execution_end", toolCallId: "b1" }] }); // failed, no result
  assert.equal(client.state().model.mutations, 1);
  s.frame({ type: "events", events: [{ type: "message_start", message: { role: "toolResult", toolCallId: "b1", content: "" } }] });
  assert.equal(client.state().model.mutations, 1);
}

// The transcript, folded through the client (formerly events.check.ts).
{
  const { client, net } = setup();
  const s = net.last();
  const m = () => client.state().model;
  const live = (...events: object[]) => s.frame({ type: "events", events });
  const call = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } };
  // Late join mid-run: one finished turn in the transcript, a tool still running.
  join(s, snapshot([
    { model: [{ role: "user", content: "hi" }] },
    { model: [{ role: "assistant", content: [{ type: "text", text: "Listing." }, call], stopReason: "toolUse" }] },
  ], { run: { inputs: [1] }, tools: [{ callId: "c1", name: "bash", status: "running", output: "a\n" }] }));
  assert.equal(m().running, true);
  assert.deepEqual(kinds(client), ["user", "assistant"]);
  const tool = () => (m().items[1] as any).blocks[1]; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(tool().state, "running");
  assert.equal(tool().output, "a\n");

  live({ type: "tool_execution_update", toolCallId: "c1", output: { trimStart: 1, append: "b\n" } });
  assert.equal(tool().output, "\nb\n");
  live({ type: "tool_execution_end", toolCallId: "c1", entry: { model: [{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "a\nb\n" }] }] } });
  assert.equal(tool().state, "done");
  assert.equal(tool().output, "a\nb\n");

  // A steer while running, then a streamed answer that ends in an error.
  live({ type: "message_start", message: { role: "user", content: "faster" } });
  assert.equal((m().items[2] as any).steer, true); // eslint-disable-line @typescript-eslint/no-explicit-any
  live({ type: "message_start", message: { role: "assistant", content: [] } });
  live({ type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Do" }] });
  live({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "ne" }] });
  assert.equal((m().items[3] as any).blocks[0].text, "Done"); // eslint-disable-line @typescript-eslint/no-explicit-any
  live({ type: "message_end", entry: { model: [{ role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "error", errorMessage: "boom" }] } }, { type: "run_end" });
  assert.equal(m().running, false);
  assert.deepEqual(m().items.at(-1), { kind: "system", level: "error", text: "boom", seq: 4 });

  // Setup notes show as system lines, live and from a snapshot.
  live({ type: "entry_appended", entry: { kind: "app.note", data: { text: "cloned", level: "info" } } });
  assert.equal((m().items.at(-1) as any).text, "cloned"); // eslint-disable-line @typescript-eslint/no-explicit-any
  const other = setup();
  join(other.net.last(), snapshot([{ kind: "app.note", data: { text: "cloning x…" } }]));
  assert.deepEqual(kinds(other.client), ["system"]);
}

// run(): one turn for a headless caller, settled by the cell's submission
// record for the prompt's requestId.
{
  const pending = Symbol("pending");
  const settled = <T>(p: Promise<T>) => Promise.race([p, new Promise<typeof pending>((r) => setTimeout(() => r(pending), 0))]);
  const submission = (requestId: unknown, status: string, rest: object = {}) =>
    ({ type: "events", events: [{ type: "submission", record: { id: 1, conversationId: "c", type: "input", requestId, status, ...rest } }] });
  const promptOf = (s: Scripted) => s.sent.find((c) => c.type === "prompt");

  // Done: waits for ready, streams through the state, resolves with the reply.
  {
    const { client, net } = setup();
    const s = net.last();
    const turn = client.run("hi");
    s.open();
    assert.equal(promptOf(s), undefined, "nothing goes out before ready");
    join(s, snapshot([]));
    const { requestId } = promptOf(s)!;
    assert.equal(typeof requestId, "string");
    const seen: string[] = [];
    client.subscribe(() => {
      const last = client.state().model.items.at(-1);
      if (last?.kind === "assistant" && last.blocks[0]?.kind === "text") seen.push(last.blocks[0].text);
    });
    s.frame(submission(requestId, "placed"));
    s.frame({ type: "events", events: [
      { type: "run_start", inputs: [1] },
      { type: "message_start", message: { role: "user", content: "hi" } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Hel" }] },
    ] });
    s.frame({ type: "events", events: [{ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] }] });
    s.frame(submission("someone-else", "done"));
    s.frame({ type: "error", error: "a title failed" }); // no requestId: not this turn's outcome
    assert.equal(await settled(turn), pending);
    s.frame({ type: "events", events: [
      { type: "message_end", entry: { id: 3, model: [{ role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop" }] } },
      { type: "run_end", inputs: [1] },
      { type: "submission", record: { requestId, status: "done", entry: 2, answer: 3 } },
    ] });
    assert.deepEqual(await turn, { status: "done", text: "Hello" });
    assert.deepEqual(seen.slice(0, 2), ["Hel", "Hello"], "the reply streams through the state");
  }

  // The reply is the answer entry the submission names, whatever the
  // transcript shows: here an error line lands mid-stream, after which the
  // reducer stops following the streamed message.
  {
    const { client, net } = setup();
    const s = net.last();
    join(s, snapshot([]));
    const turn = client.run("hi");
    const { requestId } = promptOf(s)!;
    s.frame(submission(requestId, "placed"));
    s.frame({ type: "events", events: [
      { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Using a tool" }] } },
      { type: "message_end", entry: { id: 2, model: [{ role: "assistant", content: [{ type: "text", text: "Using a tool" }], stopReason: "toolUse" }] } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Hel" }] },
    ] });
    s.frame({ type: "error", error: "a title failed" });
    s.frame({ type: "events", events: [
      { type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] },
      { type: "message_end", entry: { id: 4, model: [{ role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop" }] } },
      { type: "message_start", message: { role: "user", content: "queued by someone else" } },
      { type: "submission", record: { requestId, status: "done", entry: 1, answer: 4 } },
    ] });
    assert.deepEqual(await turn, { status: "done", text: "Hello" });

    // An answer committed in an earlier batch (a run that ends after its
    // tools), with another assistant entry committed after it.
    const ended = client.run("again");
    const answer = (id: number, text: string) => ({ type: "message_end", entry: { id, model: [{ role: "assistant", content: [{ type: "text", text }] }] } });
    s.frame({ type: "events", events: [answer(6, "Earlier"), answer(7, "Later")] });
    s.frame(submission(s.sent.at(-1)!.requestId, "done", { answer: 6 }));
    assert.deepEqual(await ended, { status: "done", text: "Earlier" });
  }

  // A snapshot mid-turn replaces batches pi-durable dropped (its watch queue
  // overflowed). The answer can be in its entries; the turn goes on while
  // the snapshot lists its submission in the run or the inbox. Otherwise the
  // settlement was among the dropped batches: the outcome is unknown, and the
  // turn ends as a drop does, `disconnected`.
  {
    const overflow = (rest: object) => ({ type: "events", events: [snapshot([
      { id: 5, model: [{ role: "user", content: "hi" }] },
      { id: 6, model: [{ role: "assistant", content: [{ type: "text", text: "From the snapshot" }] }] },
    ], rest)] });
    const { client, net } = setup();
    const s = net.last();
    join(s, snapshot([]));
    const running = client.run("hi");
    s.frame(submission(promptOf(s)!.requestId, "placed", { id: 9 }));
    s.frame(overflow({ run: { inputs: [9] } }));
    assert.equal(await settled(running), pending, "its submission is still in the run");
    s.frame(submission(promptOf(s)!.requestId, "done", { id: 9, answer: 6 }));
    assert.deepEqual(await running, { status: "done", text: "From the snapshot" });

    const queued = client.run("later");
    s.frame(submission(s.sent.at(-1)!.requestId, "queued", { id: 10 }));
    s.frame(overflow({ run: { inputs: [9] }, inbox: [{ id: 10, mode: "steer" }] }));
    assert.equal(await settled(queued), pending, "its submission is still in the inbox");

    const settledUnseen = client.run("gone");
    s.frame(submission(s.sent.at(-1)!.requestId, "placed", { id: 11 }));
    s.frame(overflow({ inbox: [{ id: 10, mode: "steer" }] }));
    assert.deepEqual(await settledUnseen, { status: "disconnected" });
    assert.equal(await settled(queued), pending);

    const unknown = client.run("no record yet"); // its record, if any, was dropped
    s.frame(overflow({ run: { inputs: [9] }, inbox: [{ id: 10, mode: "steer" }] }));
    assert.deepEqual(await unknown, { status: "disconnected" });
  }

  // A subscriber that stops the client once the run ends still gets the
  // outcome that frame carries: turns see a frame before subscribers do.
  {
    const { client, net, stop } = setup();
    const s = net.last();
    join(s, snapshot([]));
    const turn = client.run("hi");
    const { requestId } = promptOf(s)!;
    s.frame({ type: "events", events: [{ type: "run_start", inputs: [1] }] });
    client.subscribe(() => { if (!client.state().model.running) stop(); });
    s.frame({ type: "events", events: [
      { type: "message_end", entry: { id: 3, model: [{ role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop" }] } },
      { type: "run_end", inputs: [1] },
      { type: "submission", record: { requestId, status: "done", entry: 2, answer: 3 } },
    ] });
    assert.deepEqual(await turn, { status: "done", text: "Hello" });
  }

  // Error: the cell refuses the prompt, or settles it unanswered. A refusal
  // names the prompt's requestId; any other error frame is not this turn's.
  {
    const { client, net } = setup();
    const s = net.last();
    join(s, snapshot([]));
    const refused = client.run("hi");
    const other = client.run("overlapping");
    const [first, second] = s.sent.filter((c) => c.type === "prompt");
    s.frame({ type: "error", error: "a title failed" });
    assert.equal(await settled(refused), pending, "an error frame without its requestId");
    s.frame({ type: "error", error: "Session is poisoned", requestId: first.requestId });
    assert.deepEqual(await refused, { status: "error", error: "Session is poisoned" });
    assert.equal(await settled(other), pending, "another prompt's refusal");
    s.frame({ type: "error", error: "busy", requestId: second.requestId });
    assert.deepEqual(await other, { status: "error", error: "busy" });

    const failed = client.run("hi");
    s.frame(submission(promptOf(s)!.requestId, "queued"));
    s.frame(submission(s.sent.at(-1)!.requestId, "unanswered", { reason: "model_error", detail: "429 rate limited" }));
    assert.deepEqual(await failed, { status: "error", error: "429 rate limited" });

    const noModel = client.run("hi");
    s.frame(submission(s.sent.at(-1)!.requestId, "unanswered", { reason: "no_model" }));
    assert.deepEqual(await noModel, { status: "error", error: "no_model" });
  }

  // Aborted: the signal sends abort and the turn ends as the cell settles it;
  // anyone's abort ends it the same way; a signal before sending sends nothing.
  {
    const { client, net } = setup();
    const s = net.last();
    join(s, snapshot([]));
    const stop = new AbortController();
    const turn = client.run("hi", { signal: stop.signal });
    const { requestId } = s.sent.at(-1)!;
    stop.abort();
    assert.deepEqual(s.sent.at(-1), { type: "abort" });
    assert.equal(await settled(turn), pending, "resolves when the cell settles, not at the signal");
    s.frame(submission(requestId, "unanswered", { reason: "aborted" }));
    assert.deepEqual(await turn, { status: "aborted" });

    const other = client.run("hi");
    s.frame(submission(s.sent.at(-1)!.requestId, "unanswered", { reason: "aborted" }));
    assert.deepEqual(await other, { status: "aborted" });

    const sent = s.sent.length;
    assert.deepEqual(await client.run("hi", { signal: AbortSignal.abort() }), { status: "aborted" });
    const early = new AbortController();
    const waiting = setup();
    const unsent = waiting.client.run("hi", { signal: early.signal });
    early.abort();
    assert.deepEqual(await unsent, { status: "aborted" });
    join(waiting.net.last(), snapshot([]));
    assert.equal(promptOf(waiting.net.last()), undefined);
    assert.equal(s.sent.length, sent);
  }

  // Disconnected: a drop after the prompt went out ends the turn at once; the
  // rejoin resends nothing. A drop before it went out only delays it.
  {
    const { client, net, time } = setup();
    const turn = client.run("hi");
    net.last().drop();
    time.advance(RETRY_MS);
    const s = net.last();
    join(s, snapshot([]));
    assert.equal(promptOf(s)?.message, "hi");
    s.frame(submission(promptOf(s)!.requestId, "placed"));
    s.drop();
    assert.deepEqual(await turn, { status: "disconnected" });
    time.advance(RETRY_MS);
    join(net.last(), snapshot([], { run: { inputs: [1] } }));
    assert.equal(promptOf(net.last()), undefined, "never resent");
  }

  // Stopping the client settles every run(): one whose prompt went out as
  // disconnected (the turn goes on in the cell), one whose prompt did not as
  // aborted (nothing was sent).
  {
    const { client, net, stop } = setup();
    const unsent = client.run("never sent");
    const s = net.last();
    s.open();
    stop();
    assert.deepEqual(await unsent, { status: "aborted" });

    const other = setup();
    join(other.net.last(), snapshot([]));
    const sent = other.client.run("hi");
    other.stop();
    assert.deepEqual(await sent, { status: "disconnected" });
  }
}

// A Session's socket URL from the system's base URL, as headless callers get it.
assert.equal(sessionSocketUrl("http://127.0.0.1:8093", "s1"), "ws://127.0.0.1:8093/api/session/s1/ws");
assert.equal(sessionSocketUrl("https://host.ts.net/", "s1"), "wss://host.ts.net/api/session/s1/ws");
assert.equal(sessionSocketUrl("https://host/prefix", "a b"), "wss://host/prefix/api/session/a%20b/ws");

console.log("session.check ok");
