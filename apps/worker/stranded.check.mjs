// node --experimental-vm-modules stranded.check.mjs
// No prompt stays queued with no run to place it (#99). pi-durable places a
// queued prompt only at a boundary of the run it waits behind, and a run that
// ends by abort or model error reaches none; the cell withdraws what such a
// run leaves (session.js, withdrawStranded). Real Session module, real
// pi-durable Harness and SQLite storage (node:sqlite under the cell's
// CellSqlite); fakes for the model, the Directory and the workspace.
// pi-durable copies only plain objects of its own realm, and the cell runs in
// the vm's, so the data the cell hands it is cloned across.
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
    requests.push({ prompt: text(messages.findLast((m) => m.role === "user").content), signal, resolve });
    return { async *[Symbol.asyncIterator]() {}, result: () => promise };
  },
};

const clone = (value) => structuredClone(value);
function bridged(root) {
  const [submit, commit] = [root.submit.bind(root), root.commit.bind(root)];
  return Object.assign(root, {
    submit: (draft, cx) => submit(clone(draft), cx),
    commit: (change, cx) => commit((tx) => {
      const settle = tx.settleSubmission.bind(tx);
      return change(Object.assign(tx, { settleSubmission: (id, settlement) => settle(id, clone(settlement)) }));
    }, cx),
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
    Harness, watchEvents: durable.watchEvents, InboxDoc: durable.InboxDoc, LiveDoc: durable.LiveDoc,
  },
  "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage },
  "./cell-sqlite.js": undefined, // the real one
  "./workspace.js": {
    sessionWorkspace: () => ({ env: () => undefined, checkpoint: async () => {} }),
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
  const record = (requestId) => frames.flatMap((f) => (f.type === "events" ? f.events : []))
    .filter((e) => e.type === "submission" && e.record.requestId === requestId).at(-1)?.record;
  return { send, record, prompt: (id) => send({ type: "prompt", message: id.toUpperCase(), requestId: id }) };
}
const outcome = (r) => r && { status: r.status, ...(r.reason && { reason: r.reason }), ...(r.detail && { detail: r.detail }) };
const WITHDRAWN = { status: "unanswered", reason: "aborted", detail: "the run ended before this prompt joined it" };
const inbox = async (cell) => {
  const { harness, root } = await cell.open();
  return (await harness.snapshot(durable.InboxDoc, root.id, ctx)).items.map((item) => item.id);
};
async function until(done, what) {
  for (let i = 0; i < 1000; i++) {
    if (done()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`never happened: ${what}`);
}
// A runs into a model error with B queued behind it: B is left with no run.
async function strand(cell) {
  const ws = await join(cell);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  await ws.prompt("b");
  assert.equal(ws.record("b")?.status, "queued", "B waits behind A's run");
  requests.shift().resolve(unauthorized());
  await until(() => ws.record("a")?.status === "unanswered", "A's run ends");
  assert.deepEqual(outcome(ws.record("a")), { status: "unanswered", reason: "model_error", detail: "401 Incorrect API key provided" });
  assert.deepEqual(await inbox(cell), [ws.record("b").id], "B is stranded");
  return ws;
}

// Withdrawn when the run ends: the alarm track sets at run_start waits for
// idle, then withdraws B. The next prompt runs on its own.
{
  const cell = session();
  const ws = await strand(cell);
  await cell.alarm();
  assert.deepEqual(outcome(ws.record("b")), WITHDRAWN, "B is told, when A's run ends");
  assert.deepEqual(await inbox(cell), []);
  await ws.prompt("c");
  await until(() => requests.length === 1, "C reaches the model");
  assert.equal(requests[0].prompt, "C", "C runs on its own, not B");
  requests.shift().resolve(answer("C answered"));
  await until(() => ws.record("c")?.status === "done", "C is answered");
}

// Stop: what is queued when the abort lands is pi-durable's to withdraw; a
// prompt that comes in while the run winds down (here the model call ignores
// the abort, as a running sandbox command does, #86) is the cell's, once the
// abort handler sees the run end.
{
  const cell = session();
  const ws = await join(cell);
  await ws.prompt("a");
  await until(() => requests.length === 1, "A reaches the model");
  await ws.prompt("b");
  const call = requests.shift();
  const stopping = ws.send({ type: "abort" });
  await until(() => call.signal.aborted, "the abort lands");
  assert.deepEqual(outcome(ws.record("b")), { status: "unanswered", reason: "aborted" }, "pi-durable withdraws B");
  await ws.prompt("c");
  assert.equal(ws.record("c")?.status, "queued", "C waits behind the stopping run");
  call.resolve(answer("A, too late"));
  await stopping;
  assert.deepEqual(outcome(ws.record("a")), { status: "unanswered", reason: "aborted" });
  assert.deepEqual(outcome(ws.record("c")), WITHDRAWN, "C is told, when the run ends");
  assert.deepEqual(await inbox(cell), []);
}

// A Session left stranded (by older code, or a stop before the alarm ran)
// recovers when the cell next opens...
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

// ...or when it is next prompted: the prompt runs on its own.
{
  const cell = session();
  const ws = await strand(cell);
  await ws.prompt("c");
  assert.deepEqual(outcome(ws.record("b")), WITHDRAWN, "B is withdrawn before C is admitted");
  await until(() => requests.length === 1, "C reaches the model");
  assert.equal(requests[0].prompt, "C", "C runs on its own, not B");
  requests.shift().resolve(answer("C answered"));
  await until(() => ws.record("c")?.status === "done", "C is answered");
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
  assert.equal(requests[0].prompt, "B");
  const watching = cell.alarm();
  requests.shift().resolve(answer("B answered"));
  await watching;
  assert.deepEqual([outcome(ws.record("a")), outcome(ws.record("b"))], [{ status: "done" }, { status: "done" }]);
  assert.deepEqual(await inbox(cell), []);
}
console.log("stranded.check ok (a prompt an ended run leaves queued is withdrawn: at run end, on abort, at open, before the next prompt)");
