// Real published Harness and SQLite storage over the application's CellSqlite.
// Only the cell host, provider, and Sandbox SDK transport are test seams.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { sandboxEnv, shellQuote } from "./src/sandbox-env.js";
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
  const cwd = await mkdtemp(join(tmpdir(), "boxen-harness-"));
  // A repo, so the timeline's probe after each mutating call has something to say.
  const git = (...args) => execFileSync("git", ["-c", "user.name=pi", "-c", "user.email=pi@example.test", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const initial = git("rev-parse", "HEAD");
  // A bare origin outside the tree, so a push gives the branch an upstream and GitHub (stubbed) is asked for its pull request.
  const origin = await mkdtemp(join(tmpdir(), "boxen-origin-"));
  git("init", "-q", "--bare", origin);
  git("remote", "add", "origin", origin);
  const pulls = { requests: [], pull: { number: 7, html_url: "https://github.com/o/app/pull/7", title: "Add file", state: "open", draft: true, head: { sha: "" }, base: { ref: "main" }, updated_at: "2026-10-22T00:00:00Z", merged_at: null } };
  const sandbox = localSandbox(cwd);
  const env = sandboxEnv(sandbox, "test", cwd);
  const db = new DatabaseSync(":memory:");
  const storage = cellStorage(db);
  let alarms = 0, prepares = 0, saved = 0, socketCloses = 0;
  const meta = { id: "test", cwd, titled: true, repo: "https://github.com/o/app.git" };
  const kv = new Map([["meta", meta]]);
  Object.assign(storage, { async get(key) { return kv.get(key); }, async put(key, value) { kv.set(key, value); }, async setAlarm() { alarms++; } });
  const models = provider([
    tool("write", { path: "file.txt", content: "first\nsecond" }, "write"),
    tool("read", { path: "file.txt", offset: 2, limit: 1 }, "read"),
    tool("edit", { path: "file.txt", oldText: "second", newText: "changed" }, "edit"),
    tool("bash", { command: "printf out; printf err >&2; exit 7" }, "bash"),
    tool("bash", { command: "git add -A && git -c user.name=pi -c user.email=pi@example.test commit -qm 'add file'" }, "commit"),
    tool("bash", { command: "git push -q -u origin HEAD" }, "push"),
    tool("artifact", { title: "Plan", kind: "markdown", content: "body" }, "artifact"),
    answer("done"), answer("after recovery"),
  ]);
  const { Session } = await load({
    "@cloudflare/sandbox": { getSandbox: () => sandbox },
    // The VM is a second realm. Normalize only its returned JSON at the
    // test boundary (tool results, and what the cell submits); production
    // runs these modules in one worker realm.
    "@earendil-works/pi-durable": {
      ...durable,
      defineTool: (spec) => durable.defineTool({ ...spec, execute: async (...args) => structuredClone(await spec.execute(...args)) }),
      Harness: { async open(...args) {
        const harness = await durable.Harness.open(...args);
        const root = harness.root.bind(harness);
        harness.root = async (...a) => {
          const conversation = await root(...a);
          const submit = conversation.submit.bind(conversation);
          conversation.submit = (submission, context) => submit(structuredClone(submission), context);
          return conversation;
        };
        return harness;
      } },
    },
    "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage },
    "@earendil-works/pi-durable/tools": { CodingTools },
    "@earendil-works/pi-ai": { Type },
    "@earendil-works/pi-ai/providers/all": { builtinModels: () => models },
    "@earendil-works/chord/context": { BACKGROUND_CONTEXT: ctx },
    "./cell-sqlite.js": { CellSqlite },
    "./sandbox-env.js": { sandboxEnv, shellQuote }, // the real workspace over the local sandbox
    "./artifacts.js": { ARTIFACT_KINDS: ["markdown"], Artifacts: class {} },
  }, { setTimeout, clearTimeout });
  const cell = new Session({ id: "test", storage, getWebSockets: () => [{ close() { socketCloses++; } }] }, {
    DIRECTORY: { getByName: () => ({
      async defaultAgent() { return { model }; }, async touch() {}, async secrets() { return {}; },
      async github(path) { pulls.requests.push(path); return path.includes("?head=") ? [pulls.pull] : pulls.pull; },
    }) },
    ARTIFACTS: { getByName: () => ({ async save(args) { assert.equal(args.content, "body"); saved++; return { id: "artifact-id", version: 1 }; } }) },
    SESSION: { getByName: () => ({ async prepareWorkspace() { prepares++; } }) },
  });
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

    // The timeline: each mutating call's changes, by git's blob ids, before
    // the call's result; a commit as app.git with its tree, and no app.fs
    // for the paths it took along.
    const blob = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
    const written = events.filter((e) => e.type === "entry_appended" && e.entry.kind.startsWith("app.")).map((e) => e.entry);
    const fs = written.filter((e) => e.kind === "app.fs").map((e) => e.data);
    assert.deepEqual(fs.map((d) => d.call), ["write", "edit"], "read, a no-op bash and the commit record no file change");
    assert.deepEqual(fs[0], { call: "write", files: [{ status: "??", blob: blob("first\nsecond"), path: "file.txt" }], truncated: false });
    assert.deepEqual(fs[1].files, [{ status: "??", blob: blob("first\nchanged"), path: "file.txt" }]);
    const [start, commit, ...more] = written.filter((e) => e.kind === "app.git").map((e) => e.data);
    assert.equal(more.length, 0, "HEAD moved once after the first probe recorded it");
    assert.deepEqual(start, { call: "write", head: initial, branch: commit.branch, commits: [] }, "the first probe records where HEAD was, without the clone's history");
    assert.equal(commit.call, "commit");
    assert.equal(commit.head, git("rev-parse", "HEAD"));
    assert.equal(commit.branch, git("symbolic-ref", "--short", "HEAD"));
    assert.equal(commit.commits.length, 1);
    assert.equal(commit.commits[0].sha, commit.head);
    assert.equal(commit.commits[0].subject, "add file");
    assert.deepEqual(commit.commits[0].files, [{ status: "A", blob: blob("first\nchanged"), path: "file.txt" }], "the tree holds the blob the probe saw");
    const order = (type, call) => events.findIndex((e) => (e.type === "entry_appended" ? e.entry.data?.call : e.toolCallId) === call && e.type === type);
    assert(order("entry_appended", "write") < order("tool_execution_end", "write"), "the change precedes the call's result");
    assert.deepEqual(Object.keys(kv.get("probe").files), [], "the commit left nothing dirty");
    assert.equal(kv.get("probe").upstream, commit.head, "the push gave the branch an upstream");

    // The push asked GitHub for the branch's pull request, recorded it, and
    // armed a poll; the poll records a change (merged) and then stops.
    assert.deepEqual(pulls.requests, [`/repos/o/app/pulls?head=${encodeURIComponent("o:" + commit.branch)}&state=all&per_page=1`]);
    const prs = () => events.filter((e) => e.type === "entry_appended" && e.entry.kind === "app.pr").map((e) => e.entry.data);
    assert.deepEqual(prs(), [{ call: "push", number: 7, url: "https://github.com/o/app/pull/7", title: "Add file", state: "open", draft: true, head: "", base: "main", updatedAt: "2026-10-22T00:00:00Z" }]);
    assert.equal(kv.get("pr").pollMs, 60_000);
    const armed = alarms;
    await cell.pollPullRequest();
    await tick();
    assert.equal(prs().length, 1, "an unchanged pull request is not recorded again");
    assert.equal(kv.get("pr").pollMs, 120_000, "the interval grows while nothing changes");
    assert.equal(alarms, armed + 1, "an open pull request keeps the poll armed");
    pulls.pull = { ...pulls.pull, draft: false, merged_at: "2026-10-22T01:00:00Z", head: { sha: commit.head } };
    await cell.pollPullRequest();
    await tick();
    assert.deepEqual(prs().at(-1), { call: null, number: 7, url: "https://github.com/o/app/pull/7", title: "Add file", state: "merged", draft: false, head: commit.head, base: "main", updatedAt: "2026-10-22T00:00:00Z" });
    assert.equal(alarms, armed + 1, "a merged pull request is not polled again");
    await cell.pollPullRequest();
    assert.equal(pulls.requests.length, 3, "nothing is asked once it is merged");

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
    await rm(origin, { recursive: true, force: true });
  }
}
console.log("real Harness: tools, v1 SQLite migration, pending work, failure, watchers, reopen: ok");
