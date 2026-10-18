// Real published Harness and SQLite storage over the application's CellSqlite.
// Only the cell host, provider, and Sandbox SDK transport are test seams.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as durable from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { CellSqlite } from "./src/cell-sqlite.js";
import { sandboxEnv } from "./src/sandbox-env.js";
import { localSandbox } from "./local-sandbox.check.mjs";
import { load } from "./check-harness.mjs";
import { SANDBOX_EXEC_URL } from "./src/sandbox-events.js";
const { Harness, createRegistry, defineTool, defineExtension, watchEvents, SessionFailed } = durable;
const model = { provider: "faux", modelId: "faux-1" };
const answer = (text) => fauxAssistantMessage([fauxText(text)]);
const tool = (name, args, id) => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const tick = () => new Promise((r) => setImmediate(r));
const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("test timed out")), 15_000); t.unref(); })]);
function provider(responses) {
  const models = createModels(), faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return models;
}
function cellStorage(db) {
  let failure, writeFailure;
  return {
    failNext(error) { failure = error; },
    failWrite(error) { writeFailure = error; },
    sql: { exec(sql, ...p) {
      if (failure) { const e = failure; failure = undefined; throw e; }
      if (writeFailure && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) { const e = writeFailure; writeFailure = undefined; throw e; }
      const rows = db.prepare(sql).all(...p);
      return { toArray: () => rows };
    } },
    async transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try { const value = await fn(); db.exec("COMMIT"); return value; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

// SDK Process methods are capabilities, not serializable data.
{
  const { Sandbox } = await load({
    "./sandbox.js": undefined,
    "@cloudflare/sandbox": { getSandbox() {}, Sandbox: class {
      async startProcess() { return { id: "reader-id", kill() {} }; }
      async execStream(command) { return new Response(command).body; }
      async fetch() { return new Response("SDK fetch", { status: 418 }); }
    } },
  });
  const sandbox = new Sandbox();
  assert.equal(await sandbox.startReaderProcess("reader"), "reader-id");
  const response = await sandbox.fetch(new Request(SANDBOX_EXEC_URL, { method: "POST", body: JSON.stringify({ command: "stream bytes", options: {} }) }));
  assert.equal(await response.text(), "stream bytes");
  assert.equal((await sandbox.fetch(new Request("http://preview/", { method: "POST" }))).status, 418);
  assert.equal((await sandbox.fetch(new Request(SANDBOX_EXEC_URL))).status, 418);
}

// A copy of a real 1.0.0 database, not records invented using the new types.
{
  const fixture = JSON.parse(await readFile(new URL("fixtures/pi-durable-1.0.json", import.meta.url), "utf8"));
  assert.equal(fixture.runtime, "1.0.0");
  const db = new DatabaseSync(":memory:");
  for (const row of fixture.schema) db.exec(row.sql);
  for (const [table, rows] of Object.entries(fixture.tables)) for (const row of rows) {
    const names = Object.keys(row);
    db.prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(row));
  }
  const before = db.prepare("SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.tool'").all().map((r) => JSON.parse(r.record));
  assert(before.some((t) => t.version === 1 && t.state.status === "running"));
  assert(before.some((t) => t.version === 1 && t.state.status === "terminal"));
  let calls = 0;
  const registry = createRegistry();
  registry.install(defineExtension({ name: "fixture", tools: [defineTool({ name: "fixture", description: "Migration test", replay: "safe", parameters: Type.Object({ hold: Type.Boolean() }),
    async execute(args) { assert.equal(args.hold, true); calls++; return { output: [{ type: "text", text: "recovered tool output" }] }; },
  })] }));
  const options = { registry, models: provider([answer("recovered answer"), answer("queued answer")]) };
  const storage = cellStorage(db);
  let harness = await Harness.open(await SqliteStorage.open(new CellSqlite(storage)), options, ctx);
  let root = await harness.root(ctx);
  assert.equal(root.id, fixture.root);
  let stream = await watchEvents(harness, root.id, ctx);
  const history = stream.snapshot.entries.flatMap((e) => e.model ?? []);
  assert(history.some((m) => m.role === "toolResult" && m.content[0]?.text === "old tool output"));
  assert(stream.snapshot.entries.some((e) => e.kind === "app.note" && e.data.text === "old display note"));
  await stream.stop();
  harness.resume();
  await bounded(harness.waitForIdle(ctx));
  assert.equal(calls, 1, "safe in-flight v1 tool resumed once");
  for (const requestId of ["old-completed", "old-pending", "old-queued"]) {
    const existing = await root.submit({ type: "input", content: "must not run", requestId }, ctx);
    assert.equal((await existing.status(ctx)).status, "done", "durable dedup survives migration");
  }
  const migrated = db.prepare("SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.tool'").all().map((r) => JSON.parse(r.record));
  assert(migrated.some((t) => t.version === 2 && t.input.kind === "model" && t.state.status === "terminal"));
  await harness.close(ctx);
  harness = await Harness.open(await SqliteStorage.open(new CellSqlite(storage)), options, ctx);
  root = await harness.root(ctx);
  stream = await watchEvents(harness, root.id, ctx);
  const texts = stream.snapshot.entries.flatMap((e) => e.model ?? []).flatMap((m) => m.content ?? []).map((c) => c.text);
  assert(texts.includes("old answer") && texts.includes("recovered answer") && texts.includes("queued answer"));
  harness.resume();
  await bounded(harness.waitForIdle(ctx));
  assert.equal(calls, 1, "second reopen does not replay completed work");
  await stream.stop();
  await harness.close(ctx);
  db.close();
}

// A failed commit while a tool is running closes pending waiters and watchers.
{
  const db = new DatabaseSync(":memory:"), storage = cellStorage(db);
  const entered = Promise.withResolvers();
  let attempts = 0;
  const registry = createRegistry();
  registry.install(defineExtension({ name: "failure", tools: [defineTool({
    name: "wait", description: "Wait for injected failure", replay: "safe", parameters: Type.Object({}),
    async execute(_args, _api, context) {
      if (++attempts === 1) {
        entered.resolve();
        await new Promise((resolve) => context.abortSignal.addEventListener("abort", resolve, { once: true }));
      }
      return { output: [{ type: "text", text: "resumed" }] };
    },
  })] }));
  const options = { registry, models: provider([tool("wait", {}, "wait"), answer("resumed")]), onReport() {} };
  let harness = await Harness.open(await SqliteStorage.open(new CellSqlite(storage)), options, ctx);
  let root = await harness.root(ctx, { agent: { model } });
  const stream = await watchEvents(harness, root.id, ctx);
  stream.start(async () => {});
  const submission = await root.submit({ type: "input", content: "wait", requestId: "pending-failure" }, ctx);
  await bounded(entered.promise);
  const waiting = assert.rejects(submission.wait(ctx), SessionFailed);
  const idle = assert.rejects(harness.waitForIdle(ctx), SessionFailed);
  const failure = new Error("injected transaction write failure");
  storage.failWrite(failure);
  await assert.rejects(root.submit({ type: "write", entry: { kind: "app.note", data: { text: "rolled back" } } }, ctx), (e) => e === failure);
  await bounded(Promise.all([waiting, idle, stream.closed, harness.closed]));
  assert.equal((await harness.closed).reason, "failed");
  harness = await Harness.open(await SqliteStorage.open(new CellSqlite(storage)), options, ctx);
  root = await harness.root(ctx);
  const recovered = await root.submit({ type: "input", content: "wait", requestId: "pending-failure" }, ctx);
  assert.equal((await bounded(recovered.wait(ctx))).status, "done");
  assert.equal(attempts, 2);
  await harness.close(ctx);
  db.close();
}

// Real application extension, built-in tools, and Session failure/reopen path.
{
  const cwd = await mkdtemp(join(tmpdir(), "pds-harness-"));
  const sandbox = localSandbox(cwd);
  const env = sandboxEnv(sandbox, "test", cwd);
  const db = new DatabaseSync(":memory:");
  const storage = cellStorage(db);
  let alarms = 0, prepares = 0, saved = 0, socketCloses = 0;
  const meta = { id: "test", cwd, titled: true };
  Object.assign(storage, { async get() { return meta; }, async setAlarm() { alarms++; } });
  const models = provider([
    tool("write", { path: "file.txt", content: "first\nsecond" }, "write"),
    tool("read", { path: "file.txt", offset: 2, limit: 1 }, "read"),
    tool("edit", { path: "file.txt", oldText: "second", newText: "changed" }, "edit"),
    tool("bash", { command: "printf out; printf err >&2; exit 7" }, "bash"),
    tool("artifact", { title: "Plan", kind: "markdown", content: "body" }, "artifact"),
    answer("done"), answer("after recovery"),
  ]);
  const { Session } = await load({
    "@cloudflare/sandbox": { getSandbox: () => sandbox },
    // The VM is a second realm. Normalize only its returned JSON at the
    // test boundary; production runs these modules in one worker realm.
    "@earendil-works/pi-durable": { ...durable, defineTool: (spec) => durable.defineTool({ ...spec, execute: async (...args) => structuredClone(await spec.execute(...args)) }) },
    "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage },
    "@earendil-works/pi-durable/tools": { CodingTools },
    "@earendil-works/pi-ai": { Type },
    "@earendil-works/pi-ai/providers/all": { builtinModels: () => models },
    "@earendil-works/chord/context": { BACKGROUND_CONTEXT: ctx },
    "./cell-sqlite.js": { CellSqlite },
    "./artifacts.js": { ARTIFACT_KINDS: ["markdown"], Artifacts: class {} },
  }, { setTimeout, clearTimeout });
  const cell = new Session({ id: "test", storage, getWebSockets: () => [{ close() { socketCloses++; } }] }, {
    DIRECTORY: { getByName: () => ({ async defaultAgent() { return { model }; }, async touch() {} }) },
    ARTIFACTS: { getByName: () => ({ async save(args) { assert.equal(args.content, "body"); saved++; return { id: "artifact-id", version: 1 }; } }) },
    SESSION: { getByName: () => ({ async prepareWorkspace() { prepares++; } }) },
  });
  cell.workspace = async () => ({ async env() { return env; } });
  cell.report = () => {}; // injected failure is expected
  try {
    const opened = await cell.open();
    const stream = await watchEvents(opened.harness, opened.root.id, ctx);
    const events = [];
    stream.start(async (batch) => { events.push(...batch); });
    cell.streams.set({}, stream);
    const submission = await opened.root.submit({ type: "input", content: "exercise tools" }, ctx);
    assert.equal((await bounded(submission.wait(ctx))).status, "done");
    await opened.harness.waitForIdle(ctx);
    await tick();
    assert.equal(saved, 1);
    assert(prepares >= 5, "tool environments still prepare through self-RPC");
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "first\nchanged");
    const results = events.filter((e) => e.type === "tool_execution_end").map((e) => e.entry?.model?.[0]);
    assert.equal(results.find((m) => m?.toolCallId === "read").content[0].text, "second");
    assert.equal(results.find((m) => m?.toolCallId === "bash").isError, true);
    assert.match(results.find((m) => m?.toolCallId === "artifact").content[0].text, /Artifact artifact-id/);
    assert.equal(results.find((m) => m?.toolCallId === "artifact").details.artifactId, "artifact-id");

    const oldAlarms = alarms;
    const failure = new Error("injected commit failure");
    storage.failNext(failure);
    await assert.rejects(opened.root.submit({ type: "write", entry: { kind: "app.note", data: { text: "not committed" } } }, ctx), (e) => e === failure);
    await assert.rejects(opened.root.agent(ctx), SessionFailed);
    assert.deepEqual(await bounded(opened.harness.closed), { reason: "failed", error: failure });
    await bounded(stream.closed);
    for (let n = 0; n < 100 && alarms === oldAlarms; n++) await tick();
    assert(alarms > oldAlarms, "failed Harness schedules alarm recovery without a browser");
    assert.equal(cell.streams.size, 0);
    assert.equal(socketCloses, 1);
    const reopened = await cell.open();
    assert.notEqual(reopened.harness, opened.harness);
    const retry = await reopened.root.submit({ type: "input", content: "after failure" }, ctx);
    assert.equal((await bounded(retry.wait(ctx))).status, "done");
    const snapshot = await watchEvents(reopened.harness, reopened.root.id, ctx);
    assert(!snapshot.snapshot.entries.some((e) => e.data?.text === "not committed"));
    await snapshot.stop();
    await reopened.harness.close(ctx);
  } finally {
    const opened = await cell.opening?.catch(() => null);
    await opened?.harness.close(ctx);
    await env.cleanup(ctx);
    await sandbox.close();
    db.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
console.log("real Harness: tools, v1 SQLite migration, pending work, failure, watchers, reopen: ok");
