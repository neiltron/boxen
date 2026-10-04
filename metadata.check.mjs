// Real Session/Directory methods with in-memory SQLite and mocked runtime/agent boundaries.
// node --experimental-vm-modules metadata.check.mjs (Node 22+)
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { load } from "./check-harness.mjs";

const { Session, Directory, default: worker } = await load({
  "@cloudflare/sandbox": { getSandbox() { throw new Error("must not wake sandbox"); } },
}, { setTimeout: () => 1 });
const plain = (x) => JSON.parse(JSON.stringify(x));

function storage() {
  let values = new Map(), tail = Promise.resolve();
  const db = new DatabaseSync(":memory:");
  return {
    sql: { exec(sql, ...params) { const rows = db.prepare(sql).all(...params); return { toArray: () => rows }; } },
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    transaction(fn) {
      const run = tail.then(async () => {
        const before = structuredClone(values);
        try { return await fn(); } catch (e) { values = before; throw e; }
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

// A failed projection is reported; retrying the same change repairs Directory.
offline = true;
await assert.rejects(idle.updateMetadata({ archived: true }), /directory offline/);
assert.ok((await idle.meta()).archivedAt);
offline = false;
await idle.updateMetadata({ archived: true });
assert.ok((await directory.list()).find((s) => s.id === "def-456").archivedAt);

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
