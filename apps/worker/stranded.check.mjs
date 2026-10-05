// node --experimental-vm-modules stranded.check.mjs
// No prompt waits forever behind a run that ended (#99). pi-durable leaves
// what is queued behind a run that ends by abort or failure in the inbox
// until the next submission places it; the cell sets steeringMode "all", so
// that submission takes all of it along, withdraws what is left when it sees
// the agent idle, and withdraws prompts that queue behind a run being
// stopped (session.js). Real Session module, real pi-durable Harness and
// SQLite storage (node:sqlite under the cell's CellSqlite); fakes for the
// model, the Directory and the workspace. pi-durable copies only plain
// objects of its own realm, and the cell runs in the vm's, so the data the
// cell hands it is cloned across.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
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

const clone = (value) => structuredClone(value);
// One-shot hooks that put something into a race window: before the cell's
// next root.submit, after its next root.abort has resolved, and as the
// workspace's next checkpoint.
const hooks = { submit: null, abort: null, checkpoint: null };
const once = async (name) => { const hook = hooks[name]; hooks[name] = null; await hook?.(); };
function bridged(root) {
  const [submit, abort] = [root.submit.bind(root), root.abort.bind(root)];
  return Object.assign(root, {
    async submit(draft, cx) { await once("submit"); return submit(clone(draft), cx); },
    async abort(cx) { await abort(cx); await once("abort"); },
  });
}
const Harness = {
  async open(storage, options, cx) {
    const harness = await durable.Harness.open(storage, options, cx);
    const root = harness.root.bind(harness);
    harness.root = async (cx, o) => bridged(await root(cx, clone(o)));
    return harness;
  },
};

const { Session } = await load({
  "@earendil-works/chord/context": { BACKGROUND_CONTEXT: ctx },
  "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
  "@earendil-works/pi-ai/providers/all": { builtinModels: () => models },
  "@earendil-works/pi-durable": {
    // The cell's extensions don't matter here; the built-in tasks do.
    createRegistry() {
      const registry = durable.createRegistry();
      return { install() {}, snapshot: () => registry.snapshot(), subscribe: (f) => registry.subscribe(f) };
    },
    defineExtension: (x) => x, defineTool() {}, section() {},
    Harness, watchEvents: durable.watchEvents,
  },
  "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage },
  "./cell-sqlite.js": undefined, // the real one
  "./workspace.js": {
    sessionWorkspace: () => ({ env: () => undefined, checkpoint: () => once("checkpoint") }),
    previewTarget() {}, validPreviewPort() {}, PREVIEW_PORT: 0,
  },
}, { setTimeout: () => 0 }); // watchRun's 10-minute bound never fires

// A cell's storage: SQL in node:sqlite, the rest in a Map. Kept across a restart.
function storage() {
  const db = new DatabaseSync(":memory:");
  const kv = new Map([["meta", { id: "s1", name: "check", cwd: "/workspace", titled: true }]]);
  return {
    sql: { exec(sql, ...params) { const rows = db.prepare(sql).all(...params); return { toArray: () => rows }; } },
    async get(key) { return clone(kv.get(key)); },
    async put(key, value) { kv.set(key, clone(value)); },
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
const session = (store = storage()) => new Session({ id: "cell", storage: store }, env);

// A joined socket: commands in, every frame kept.
async function join(cell) {
  const frames = [];
  const ws = { send: (m) => frames.push(JSON.parse(m)) };
  const send = (cmd) => cell.webSocketMessage(ws, JSON.stringify(cmd));
  await send({ type: "sub" });
  const events = () => frames.flatMap((f) => (f.type === "events" ? f.events : []));
  const record = (requestId) => events().filter((e) => e.type === "submission" && e.record.requestId === requestId).at(-1)?.record;
  const notes = () => events().filter((e) => e.type === "entry_appended" && e.entry.kind === "app.note").map((e) => e.entry.data.text);
  return { send, record, notes, prompt: (id) => send({ type: "prompt", message: id.toUpperCase(), requestId: id }) };
}
const outcome = (r) => r && { status: r.status, ...(r.reason && { reason: r.reason }) };
const WITHDRAWN = { status: "unanswered", reason: "aborted" };
const DONE = { status: "done" };
const inbox = async (cell) => (await (await cell.open()).harness.inspect(ctx)).submissions.filter((s) => s.status === "queued").map((s) => s.id);
async function until(done, what) {
  for (let i = 0; i < 1000; i++) {
    if (done()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`never happened: ${what}`);
}
// A runs into a model error with B (and whatever `meanwhile` adds) queued
// behind it: B is left in the inbox with no run.
async function strand(cell, meanwhile) {
  const ws = await join(cell);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  await ws.prompt("b");
  assert.equal(ws.record("b")?.status, "queued", "B waits behind A's run");
  await meanwhile?.();
  requests.shift().resolve(unauthorized());
  await until(() => ws.record("a")?.status === "unanswered", "A's run ends");
  assert.deepEqual(outcome(ws.record("a")), { status: "unanswered", reason: "model_error" });
  assert.equal((await inbox(cell))[0], ws.record("b").id, "B is left behind");
  return ws;
}

// A run fails with a prompt queued: the alarm track sets at run_start waits
// for idle, then withdraws B. A note queued behind A stays, as pi-durable
// keeps writes, and the next submission places it. The next prompt runs on
// its own.
{
  const cell = session();
  const ws = await strand(cell, () => cell.note("cloned into /workspace"));
  await cell.alarm();
  assert.deepEqual(outcome(ws.record("b")), WITHDRAWN, "B is told, when A's run ends");
  assert.equal((await inbox(cell)).length, 1, "only the note waits");
  await ws.prompt("c");
  await until(() => requests.length === 1, "C reaches the model");
  assert.deepEqual(requests[0].users, ["A", "C"], "C runs on its own, not with B");
  assert.deepEqual(ws.notes(), ["cloned into /workspace"]);
  requests.shift().resolve(answer("C answered"));
  await until(() => ws.record("c")?.status === "done", "C is answered");
}

// ...or a prompt reaches the idle Session before the alarm does: it takes B
// along, and one run answers both.
{
  const cell = session();
  const ws = await strand(cell);
  await ws.prompt("c");
  await until(() => requests.length === 1, "B and C reach the model");
  assert.deepEqual(requests[0].users, ["A", "B", "C"], "one run for B and C");
  requests.shift().resolve(answer("B and C answered"));
  await until(() => ws.record("c")?.status === "done", "C is answered");
  assert.deepEqual([outcome(ws.record("b")), outcome(ws.record("c"))], [DONE, DONE]);
  assert.deepEqual(await inbox(cell), []);
}

// Review finding 2: A fails between C's arrival and its admission. With one
// steer per boundary, C's admission placed B and queued C behind it, the
// cascade; now it places both.
{
  const cell = session();
  const ws = await join(cell);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  await ws.prompt("b");
  const call = requests.shift();
  hooks.submit = async () => {
    call.resolve(unauthorized());
    await until(() => ws.record("a")?.status === "unanswered", "A's run ends");
  };
  await ws.prompt("c");
  await until(() => requests.length === 1, "the next run reaches the model");
  assert.deepEqual(requests[0].users, ["A", "B", "C"], "C's admission places B and C together");
  requests.shift().resolve(answer("B and C answered"));
  await until(() => ws.record("c")?.status === "done", "C is answered");
  assert.deepEqual([outcome(ws.record("b")), outcome(ws.record("c"))], [DONE, DONE]);
  assert.deepEqual(await inbox(cell), []);
}

// Stop: a prompt queued before it is withdrawn by pi-durable's abort; one
// that comes in while the run winds down (here the model call ignores the
// abort, as a running sandbox command does, #86) withdraws itself at once.
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
  assert.deepEqual(outcome(ws.record("c")), WITHDRAWN, "C is withdrawn while the run winds down");
  call.resolve(answer("A, too late"));
  await stopping;
  assert.deepEqual(outcome(ws.record("a")), WITHDRAWN);
  assert.deepEqual(await inbox(cell), []);
}

// Review finding 1: a workspace note (a restore, a clone) admitted after the
// stopped run ends and before anything else: admitting it into an idle
// Session places what is queued, and nothing is.
{
  const cell = session();
  const ws = await join(cell);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  const call = requests.shift();
  const stopping = ws.send({ type: "abort" });
  await until(() => call.signal.aborted, "the abort lands");
  await ws.prompt("c");
  hooks.abort = () => cell.note("restored the workspace from its last checkpoint");
  call.resolve(answer("A, too late"));
  await stopping;
  assert.deepEqual(ws.notes(), ["restored the workspace from its last checkpoint"]);
  assert.deepEqual(outcome(ws.record("c")), WITHDRAWN, "the note starts no run for C");
  assert.equal(requests.length, 0, "the model never hears C");
  assert.deepEqual(await inbox(cell), []);
}

// A Session left with a prompt behind an ended run (by older code, or a stop
// before the alarm ran) has it withdrawn when the cell next opens.
{
  const store = storage();
  const before = session(store);
  const b = (await strand(before)).record("b").id;
  await (await before.open()).harness.close(ctx);
  const cell = session(store);
  const { harness } = await cell.open();
  assert.deepEqual(await inbox(cell), [], "B is withdrawn at open");
  assert.deepEqual(outcome(await (await harness.submission(b, ctx)).status(ctx)), WITHDRAWN);
}

// A run that starts while the alarm finishes after the last one (its
// workspace checkpoint takes seconds) is watched to its end too: its alarm
// joins the finishing watch, which must not finish with D left behind C.
{
  const cell = session();
  const ws = await join(cell);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  const watching = cell.alarm();
  hooks.checkpoint = async () => {
    await ws.prompt("c");
    await until(() => requests.length === 1, "C reaches the model");
    assert.equal(cell.alarm(), watching, "C's alarm joins the watch");
    await ws.prompt("d");
    requests.shift().resolve(unauthorized());
    await until(() => ws.record("c")?.status === "unanswered", "C's run ends");
  };
  requests.shift().resolve(answer("A answered"));
  await watching;
  assert.deepEqual(outcome(ws.record("d")), WITHDRAWN, "D is withdrawn once C's run has ended");
  assert.deepEqual(await inbox(cell), []);
}

// ...but a prompt behind a run that is still going stays: a cell stopped
// mid-run (a node restart) reopens, resumes the run, and the prompt joins it.
{
  const store = storage();
  const before = session(store);
  const ws = await join(before);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  await ws.prompt("b");
  const closing = (await before.open()).harness.close(ctx);
  requests.shift().resolve(answer("A, cut off"));
  await closing;
  const cell = session(store);
  const again = await join(cell);
  await until(() => requests.length === 1, "the resumed run asks again");
  assert.deepEqual(await inbox(cell), [ws.record("b").id], "B still waits behind A");
  requests.shift().resolve(answer("A answered"));
  await until(() => requests.length === 1, "B reaches the model");
  assert.deepEqual(requests[0].users, ["A", "B"]);
  requests.shift().resolve(answer("B answered"));
  await until(() => again.record("b")?.status === "done", "B is answered");
}

// Unchanged: a steer into a run that ends normally is placed at its final
// boundary and answered in the next run; the alarm withdraws nothing.
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
  assert.deepEqual(await inbox(cell), []);
}
console.log("stranded.check ok (nothing waits behind an ended run: taken along by the next submission, withdrawn at idle, open and Stop)");
