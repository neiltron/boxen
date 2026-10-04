// Real Session/Directory methods with in-memory SQLite and mocked runtime/agent boundaries.
// node --experimental-vm-modules metadata.check.mjs (Node 22+)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { DatabaseSync } from "node:sqlite";

let sandbox;
const context = createContext({ Request, Response, URL, atob, console, setTimeout: () => 1 });
const stubs = {
  "cloudflare:workers": { DurableObject: class {} },
  "@cloudflare/sandbox": { getSandbox() { if (!sandbox) throw new Error("must not wake sandbox"); return sandbox; } },
  "@earendil-works/chord/context": { BACKGROUND_CONTEXT: {} },
  "@earendil-works/pi-ai": { Type: {} },
  "@earendil-works/pi-ai/bun-oauth": { registerBunOAuthFlows() {} },
  "@earendil-works/pi-ai/models": { getSupportedThinkingLevels: () => ["off"] },
  "@earendil-works/pi-ai/providers/all": { builtinModels() {} },
  "@earendil-works/pi-durable": {
    createRegistry() {}, defineExtension: (x) => x, defineTool() {}, Harness: {}, section() {}, watchEvents() {},
  },
  "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage: {} },
  "@earendil-works/pi-durable/tools": { CodingTools: {} },
  "./artifacts.js": { ARTIFACT_KINDS: [], Artifacts: class {} },
  "./sandbox.js": { Sandbox: class {} },
  "./cell-sqlite.js": { CellSqlite: class {} },
  "./credentials.js": { directoryCredentials() {} },
  "./sandbox-env.js": { sandboxEnv() {}, shellQuote() {} },
};
const modules = new Map();
async function link(name) {
  if (modules.has(name)) return modules.get(name);
  const exports = stubs[name];
  const module = exports
    ? new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context })
    : new SourceTextModule(await readFile(new URL(`src/${name}`, import.meta.url), "utf8"), { context });
  modules.set(name, module);
  await module.link(link);
  return module;
}
const entry = await link("index.js");
await entry.evaluate();
const { Session, Directory, default: worker } = entry.namespace;
const plain = (x) => JSON.parse(JSON.stringify(x));

function storage() {
  let values = new Map(), alarm = null, tail = Promise.resolve();
  const db = new DatabaseSync(":memory:");
  return {
    sql: { exec(sql, ...params) { const rows = db.prepare(sql).all(...params); return { toArray: () => rows }; } },
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async getAlarm() { return alarm; },
    async setAlarm(time) { alarm = time; },
    async consumeAlarm() { alarm = null; },
    transaction(fn) {
      const run = tail.then(async () => {
        const before = structuredClone(values), beforeAlarm = alarm;
        try { return await fn(); } catch (e) { values = before; alarm = beforeAlarm; throw e; }
      });
      tail = run.catch(() => {});
      return run;
    },
  };
}
const ds = storage();
// Start with the old schema, including an existing session, to test migration.
ds.sql.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT, cwd TEXT, status TEXT, createdAt INT, lastActivity INT)`).toArray();
ds.sql.exec(`INSERT INTO sessions VALUES ('old', 'Old', '/workspace', 'idle', 1, 2)`).toArray();
const directory = new Directory({ storage: ds }, {});
assert.equal((await directory.list())[0].archivedAt, null);
assert.equal((await directory.list())[0].metadataRevision, 0);
let offline = false;
const env = { DIRECTORY: { getByName: () => ({
  async projectMetadata(meta) {
    if (offline) throw new Error("directory offline");
    return directory.projectMetadata(meta);
  },
}) } };
async function make(id, extra = {}) {
  const state = { storage: storage() };
  const meta = { id, name: "Untitled", cwd: "/workspace", createdAt: 10, titled: false, ...extra };
  await state.storage.put("meta", meta);
  await directory.register(meta);
  const cell = new Session(state, env);
  cell.open = () => { throw new Error("must not open Harness"); };
  return cell;
}
const cell = await make("abc-123");
const messages = [[], []];
for (const list of messages) cell.streams.set({ send: (s) => list.push(JSON.parse(s)) }, {});
const beforeActivity = (await directory.list()).find((s) => s.id === "abc-123").lastActivity;
await Promise.all([cell.rename("  Investigate reconnects  "), cell.updateMetadata({ archived: true })]);
let meta = await cell.meta();
assert.equal(meta.name, "Investigate reconnects");
assert.equal(meta.titled, true);
assert.ok(meta.archivedAt);
const archivedAt = meta.archivedAt;
const revision = meta.metadataRevision;
await cell.updateMetadata({ archived: true });
assert.equal((await cell.meta()).archivedAt, archivedAt);
assert.equal((await cell.meta()).metadataRevision, revision, "repeat archive is a no-op");
for (const list of messages) assert.equal(list.at(-1).meta.archivedAt, archivedAt, "both browsers receive metadata");
await directory.touch({ id: meta.id, status: "running" });
assert.equal((await directory.list()).find((s) => s.id === meta.id).archivedAt, archivedAt);
await directory.register({ ...meta, name: "stale registration", createdAt: 999 });
let row = (await directory.list()).find((s) => s.id === meta.id);
assert.equal(row.name, meta.name);
assert.equal(row.status, "running");
assert.equal(row.archivedAt, archivedAt);
await directory.projectMetadata({ ...meta, name: "stale projection", archivedAt: null, metadataRevision: 1 });
assert.equal((await directory.list()).find((s) => s.id === meta.id).name, meta.name);
await cell.updateMetadata({ archived: false });
assert.equal((await cell.meta()).archivedAt, null);
const restoredRevision = (await cell.meta()).metadataRevision;
await cell.updateMetadata({ archived: false });
assert.equal((await cell.meta()).metadataRevision, restoredRevision);
const idle = await make("def-456");
await idle.rename("New name");
assert.equal((await directory.list()).find((s) => s.id === "def-456").lastActivity, beforeActivity, "metadata does not bump activity");

// Failed projection survives eviction. Alarm retries without opening the agent.
offline = true;
await idle.updateMetadata({ archived: true });
assert.ok(await idle.state.storage.get("pendingMetadata"));
assert.ok(await idle.state.storage.getAlarm());
const restarted = new Session(idle.state, env);
restarted.open = idle.open;
await idle.state.storage.consumeAlarm();
await restarted.alarm();
assert.ok(await idle.state.storage.getAlarm(), "failure rearms retry");
offline = false;
await idle.state.storage.consumeAlarm();
await restarted.alarm();
assert.equal(await idle.state.storage.get("pendingMetadata"), undefined);
assert.ok((await directory.list()).find((s) => s.id === "def-456").archivedAt);
assert.equal((await restarted.meta()).name, "New name");

// Running and legacy alarms still resume. Archive never calls abort.
for (const legacy of [false, true]) {
  const running = await make(legacy ? "legacy" : "running");
  if (legacy) await running.state.storage.setAlarm(Date.now());
  else await running.scheduleRun();
  await running.updateMetadata({ archived: true });
  let watched = 0;
  running.watchRun = async () => { watched++; };
  await running.state.storage.consumeAlarm();
  await running.alarm();
  assert.equal(watched, 1);
}

// An old alarm delivered concurrently with a metadata edit is still a run alarm.
const racing = await make("legacy-race");
let resumed = 0;
racing.watchRun = async () => { resumed++; };
await Promise.all([racing.updateMetadata({ archived: true }), racing.alarm()]);
assert.equal(resumed, 1);

// A completed run must not be awakened again by a metadata retry. Conversely,
// a new run starting during checkpoint must retain its durable resume intent.
const lifecycle = await make("lifecycle");
let opens = 0;
lifecycle.open = async () => { opens++; return { harness: { waitForIdle: async () => {} } }; };
lifecycle.setStatus = async () => {};
sandbox = { checkpoint: async () => {} };
await lifecycle.scheduleRun();
await lifecycle.state.storage.consumeAlarm();
await lifecycle.alarm();
assert.equal(await lifecycle.state.storage.get("runPending"), false);
await lifecycle.updateMetadata({ archived: true });
await lifecycle.state.storage.consumeAlarm();
await lifecycle.alarm();
assert.equal(opens, 1, "metadata alarm after a run stays idle");
await lifecycle.scheduleRun();
sandbox.checkpoint = () => lifecycle.scheduleRun();
await lifecycle.state.storage.consumeAlarm();
await lifecycle.alarm();
assert.equal(await lifecycle.state.storage.get("runPending"), true);
assert.ok(await lifecycle.state.storage.getAlarm(), "new run keeps an alarm after old checkpoint");
sandbox.checkpoint = async () => {};
await lifecycle.state.storage.consumeAlarm();
await lifecycle.alarm();
assert.equal(await lifecycle.state.storage.get("runPending"), false);
sandbox = undefined;

// A manual rename wins even if an automatic title request is already in flight.
const auto = await make("auto");
const started = Promise.withResolvers(), reply = Promise.withResolvers();
const models = { getModel: () => ({}), completeSimple() { started.resolve(); return reply.promise; } };
const root = { agent: async () => ({ model: { provider: "test", modelId: "test" } }) };
const generating = auto.autoTitle(models, root, "first prompt");
await started.promise;
await auto.rename("My explicit title");
await auto.updateMetadata({ archived: true });
reply.resolve({ stopReason: "stop", content: [{ type: "text", text: "Generated title" }] });
await generating;
assert.equal((await auto.meta()).name, "My explicit title");
assert.ok((await auto.meta()).archivedAt);
const normal = await make("normal");
await normal.autoTitle(models, root, "first prompt");
assert.equal((await normal.meta()).name, "Generated title");

// Archiving alone must not suppress the first generated title.
const autoArchived = await make("auto-archived");
const titleStarted = Promise.withResolvers(), titleReply = Promise.withResolvers();
const titling = autoArchived.autoTitle({
  getModel: () => ({}),
  completeSimple() { titleStarted.resolve(); return titleReply.promise; },
}, root, "prompt");
await titleStarted.promise;
await autoArchived.updateMetadata({ archived: true });
titleReply.resolve({ stopReason: "stop", content: [{ type: "text", text: "Archived title" }] });
await titling;
assert.equal((await autoArchived.meta()).name, "Archived title");
assert.ok((await autoArchived.meta()).archivedAt);

// Existing WebSocket clients use the same canonical mutation path.
await cell.webSocketMessage({ send() {} }, JSON.stringify({ type: "rename", name: "WebSocket name" }));
assert.equal((await cell.meta()).name, "WebSocket name");
assert.equal((await directory.list()).find((s) => s.id === "abc-123").name, "WebSocket name");

// HTTP contract: validation, not-found, canonical response, and CORS.
const httpEnv = { SESSION: { getByName: (id) => id === "abc-123" ? cell : new Session({ storage: storage() }, env) } };
const request = (body, id = "abc-123") => new Request(`https://example.test/api/session/${id}`, {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
for (const body of [null, [], {}, { name: "   " }, { name: 42 }, { name: "x".repeat(121) }, { archived: 1 }, { status: "idle" }]) {
  assert.equal((await worker.fetch(request(body), httpEnv)).status, 400, JSON.stringify(body));
}
assert.equal((await worker.fetch(new Request(request({}).url, { method: "PATCH", body: "{" }), httpEnv)).status, 400);
assert.equal((await worker.fetch(request({ archived: true }, "0000"), httpEnv)).status, 404);
const response = await worker.fetch(request({ name: "  HTTP title ", archived: true }), httpEnv);
assert.equal(response.status, 200);
assert.equal((await response.json()).name, "HTTP title");
const options = await worker.fetch(new Request(request({}).url, { method: "OPTIONS" }), httpEnv);
assert.match(options.headers.get("access-control-allow-methods"), /PATCH/);
assert.deepEqual(plain(await cell.meta()), plain(await new Session(cell.state, env).meta()));
console.log("metadata.check ok");
