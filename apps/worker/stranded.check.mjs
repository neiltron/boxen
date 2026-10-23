// node --experimental-vm-modules stranded.check.mjs
// No prompt waits forever behind a run that ended (#10). pi-durable leaves
// what is queued behind a run that ends by abort or failure in the inbox
// until the next submission places it. The cell sets steeringMode "all", so
// that submission takes all of it along, and withdraws what is left once it
// sees the agent idle (a prompt's hold, the alarm) and when it opens
// (session.js). Real Session module, real pi-durable Harness and SQLite
// storage over the cell's CellSqlite; fakes for the model, the Directory and
// the workspace.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import * as durable from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CellSqlite } from "./src/cell-sqlite.js";
import { load } from "./check-harness.mjs";

// The model: each request waits until the check answers it.
const requests = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (fields) => ({ role: "assistant", content: [], api: "fake", provider: "fake", model: "m", usage, timestamp: Date.now(), ...fields });
const answer = (text) => reply({ stopReason: "stop", content: [{ type: "text", text }] });
const unauthorized = () => reply({ stopReason: "error", errorMessage: "401 Incorrect API key provided" });
const text = (content) => (typeof content === "string" ? content : content.map((c) => c.text).join(""));
const models = {
  getModel: (provider, id) => ({ provider, id, api: "fake", contextWindow: 0 }),
  streamSimple(model, { messages }, { signal }) {
    const { promise, resolve } = Promise.withResolvers();
    requests.push({ users: messages.filter((m) => m.role === "user").map((m) => text(m.content)), signal, resolve });
    return { async *[Symbol.asyncIterator]() {}, result: () => promise };
  },
};

// One-shot hook after the cell's next root.abort has resolved.
let afterAbort = null;
const Harness = {
  async open(storage, options, cx) {
    const harness = await durable.Harness.open(storage, options, cx);
    const root = harness.root.bind(harness);
    harness.root = async (cx, o) => {
      const r = await root(cx, structuredClone(o));
      const abort = r.abort.bind(r);
      // The VM is a second realm: pi-durable copies only its own plain objects.
      const submit = r.submit.bind(r);
      return Object.assign(r, {
        submit: (draft, cx) => submit(structuredClone(draft), cx),
        async abort(cx) { await abort(cx); const hook = afterAbort; afterAbort = null; await hook?.(); },
      });
    };
    return harness;
  },
};

const { Session } = await load({
  "@earendil-works/chord/context": { BACKGROUND_CONTEXT: ctx },
  "@earendil-works/pi-ai": { Type },
  "@earendil-works/pi-ai/providers/all": { builtinModels: () => models },
  // The cell's own tools don't matter here.
  "@earendil-works/pi-durable": { ...durable, Harness, createRegistry() {
    const registry = durable.createRegistry();
    return { install() {}, snapshot: () => registry.snapshot(), subscribe: (f) => registry.subscribe(f) };
  } },
  "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage },
  "./cell-sqlite.js": { CellSqlite },
  "./workspace.js": { sessionWorkspace: () => ({ env: () => undefined, checkpoint: async () => {} }), previewTarget() {}, validPreviewPort() {}, PREVIEW_PORT: 0 },
}, { setTimeout: () => 0 }); // the hold's and the alarm's bounds never fire

// A cell's storage: SQL in node:sqlite, the rest in a Map. Kept across a restart.
function storage() {
  const db = new DatabaseSync(":memory:");
  const kv = new Map([["meta", { id: "s1", name: "check", cwd: "/workspace", titled: true }]]);
  return {
    sql: { exec(sql, ...params) { const rows = db.prepare(sql).all(...params); return { toArray: () => rows }; } },
    async get(key) { return structuredClone(kv.get(key)); },
    async put(key, value) { kv.set(key, structuredClone(value)); },
    async setAlarm() {},
    async transaction(fn) {
      db.exec("BEGIN");
      try { const result = await fn(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}
const env = {
  DIRECTORY: { getByName: () => ({ defaultAgent: async () => ({ model: { provider: "fake", modelId: "m" }, thinkingLevel: "off" }), touch: async () => {} }) },
  ARTIFACTS: { getByName: () => ({}) },
  SESSION: { getByName: () => ({ prepareWorkspace: async () => {} }) },
};
const session = (store = storage()) => {
  const cell = new Session({ id: "cell", storage: store, getWebSockets: () => [] }, env);
  cell.report = () => {};
  return cell;
};

async function until(done, what) {
  for (let i = 0; i < 2000; i++) {
    if (await done()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`never happened: ${what}`);
}
// A joined socket. A prompt's handler holds until its run is idle, so prompts
// are sent, not awaited: prompt() returns once the cell has admitted it.
async function join(cell) {
  const frames = [];
  const ws = { send: (m) => frames.push(JSON.parse(m)) };
  const send = (cmd) => cell.webSocketMessage(ws, JSON.stringify(cmd));
  await send({ type: "sub" });
  const events = () => frames.flatMap((f) => (f.type === "events" ? f.events : []));
  const record = (requestId) => events().filter((e) => e.type === "submission" && e.record.requestId === requestId).at(-1)?.record;
  const notes = () => events().filter((e) => e.type === "entry_appended" && e.entry.kind === "app.note").map((e) => e.entry.data.text);
  const prompt = async (id) => {
    void send({ type: "prompt", message: id.toUpperCase(), requestId: id });
    await until(() => record(id), `${id} is admitted`);
  };
  return { send, record, notes, prompt };
}
const outcome = (r) => r && { status: r.status, ...(r.reason && { reason: r.reason }) };
const WITHDRAWN = { status: "unanswered", reason: "aborted" };
const DONE = { status: "done" };
const queued = async (cell) => (await (await cell.open()).harness.inspect(ctx)).submissions.filter((s) => s.status === "queued").map((s) => s.id);
// What a cell with no prompt handlers holding leaves (older code, a restart
// before the cleanup ran): A's run failed, B is queued behind it.
async function stranded(cell) {
  const { root } = await cell.open();
  const a = await root.submit({ type: "input", content: "A" }, ctx);
  await until(() => requests.length === 1, "A reaches the model");
  const b = await root.submit({ type: "input", content: "B", whenBusy: "steer" }, ctx);
  requests.shift().resolve(unauthorized());
  await until(async () => (await a.status(ctx)).status === "unanswered", "A's run fails");
  assert.deepEqual(await queued(cell), [b.id], "B is left behind");
  return b;
}

// A run fails with B queued behind it: B is withdrawn once the agent is idle,
// a workspace note meanwhile is appended at once, and the next prompt runs on
// its own.
{
  const cell = session();
  const ws = await join(cell);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  await ws.prompt("b");
  assert.equal(ws.record("b").status, "queued", "B waits behind A's run");
  await cell.note("cloned into /workspace");
  requests.shift().resolve(unauthorized());
  await until(() => outcome(ws.record("b"))?.reason === "aborted", "B is withdrawn");
  assert.deepEqual(outcome(ws.record("a")), { status: "unanswered", reason: "model_error" });
  assert.deepEqual(await queued(cell), []);
  assert.deepEqual(ws.notes(), ["cloned into /workspace"]);
  await ws.prompt("c");
  await until(() => requests.length === 1, "C reaches the model");
  assert.deepEqual(requests[0].users, ["A", "C"], "C runs on its own, not with B");
  requests.shift().resolve(answer("C answered"));
  await until(() => ws.record("c")?.status === "done", "C is answered");
}

// A prompt that reaches the idle Session before the cleanup takes what was
// left along: one run answers both, rather than placing B and queueing C
// behind it (the cascade).
{
  const cell = session();
  await stranded(cell);
  const ws = await join(cell);
  await ws.prompt("c");
  await until(() => requests.length === 1, "B and C reach the model");
  assert.deepEqual(requests[0].users, ["A", "B", "C"], "one run for B and C");
  requests.shift().resolve(answer("B and C answered"));
  await until(() => ws.record("c")?.status === "done", "C is answered");
  assert.deepEqual(await queued(cell), []);
}

// Stop: a prompt queued before it is withdrawn by pi-durable's abort; one that
// comes in while the run winds down (the model call ignores the abort, as a
// running sandbox command can) is withdrawn once the run has ended. A
// workspace note right after the run ends starts no run for it.
{
  const cell = session();
  const ws = await join(cell);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  await ws.prompt("b");
  const call = requests.shift();
  const stopping = ws.send({ type: "abort" });
  await until(() => call.signal.aborted, "the abort lands");
  assert.deepEqual(outcome(ws.record("b")), WITHDRAWN, "pi-durable withdraws B");
  await ws.prompt("c");
  afterAbort = () => cell.note("restored the workspace from its last checkpoint");
  call.resolve(answer("A, too late"));
  await stopping;
  await until(() => outcome(ws.record("c"))?.reason === "aborted", "C is withdrawn");
  assert.deepEqual(outcome(ws.record("a")), WITHDRAWN);
  assert.deepEqual(ws.notes(), ["restored the workspace from its last checkpoint"]);
  assert.equal(requests.length, 0, "the model never hears C");
  assert.deepEqual(await queued(cell), []);
}

// A Session left with a prompt behind an ended run has it withdrawn when the
// cell next opens.
{
  const store = storage();
  const before = session(store);
  const b = await stranded(before);
  await (await before.open()).harness.close(ctx);
  const cell = session(store);
  const { harness } = await cell.open();
  assert.deepEqual(await queued(cell), [], "B is withdrawn at open");
  assert.deepEqual(outcome(await (await harness.submission(b.id, ctx)).status(ctx)), WITHDRAWN);
  await harness.close(ctx);
}

// ...but a prompt behind a run that is still going stays: a cell stopped
// mid-run (a node restart) reopens, resumes the run, and the prompt joins it.
{
  const store = storage();
  const before = session(store);
  const { harness, root } = await before.open();
  await root.submit({ type: "input", content: "A" }, ctx);
  await until(() => requests.length === 1, "A reaches the model");
  const b = await root.submit({ type: "input", content: "B", whenBusy: "steer" }, ctx);
  const closing = harness.close(ctx);
  requests.shift().resolve(answer("A, cut off"));
  await closing;
  const cell = session(store);
  await join(cell);
  await until(() => requests.length === 1, "the resumed run asks again");
  assert.deepEqual(await queued(cell), [b.id], "B still waits behind A");
  requests.shift().resolve(answer("A answered"));
  await until(() => requests.length === 1, "B reaches the model");
  assert.deepEqual(requests[0].users, ["A", "B"]);
  requests.shift().resolve(answer("B answered"));
  const { harness: reopened } = await cell.open();
  await until(async () => (await (await reopened.submission(b.id, ctx)).status(ctx)).status === "done", "B is answered");
}

// Unchanged: a steer into a run that ends normally is placed at its final
// boundary and answered in the next run; nothing is withdrawn.
{
  const cell = session();
  const ws = await join(cell);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  await ws.prompt("b");
  requests.shift().resolve(answer("A answered"));
  await until(() => requests.length === 1, "B reaches the model");
  assert.deepEqual(requests[0].users, ["A", "B"]);
  const watching = cell.alarm();
  requests.shift().resolve(answer("B answered"));
  await watching;
  assert.deepEqual([outcome(ws.record("a")), outcome(ws.record("b"))], [DONE, DONE]);
  assert.deepEqual(await queued(cell), []);
}
console.log("stranded.check ok (nothing waits behind an ended run: taken along by the next prompt, withdrawn at idle and at open)");
