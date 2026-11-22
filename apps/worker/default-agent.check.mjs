// Real Directory + pinned pi-ai catalogs, credential filters, and Session
// initialization through the real Harness. No live model invocation needed.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { directoryCredentials } from "./src/credentials.js";
import { load } from "./check-harness.mjs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import * as durable from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { CellSqlite } from "./src/cell-sqlite.js";

const { Directory } = await load({
  "@cloudflare/sandbox": { getSandbox() { throw new Error("must not wake sandbox"); } },
  "@earendil-works/pi-ai/providers/all": { builtinModels },
  "@earendil-works/pi-ai/models": { getSupportedThinkingLevels },
  "./credentials.js": undefined,
}, { setTimeout: () => 1 });
const plain = (x) => JSON.parse(JSON.stringify(x));
const states = [];
function state() {
  const db = new DatabaseSync(":memory:");
  let values = new Map(), tail = Promise.resolve();
  const result = { id: "test", db, storage: {
    sql: { exec(sql, ...params) { const rows = db.prepare(sql).all(...params); return { toArray: () => rows }; } },
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    transaction(fn) {
      const run = tail.then(async () => {
        const before = structuredClone(values);
        db.exec("BEGIN IMMEDIATE");
        try { const result = await fn(); db.exec("COMMIT"); return result; }
        catch (e) { db.exec("ROLLBACK"); values = before; throw e; }
      });
      tail = run.catch(() => {});
      return run;
    },
  } };
  states.push(result);
  return result;
}
const stored = state();
let directory = new Directory(stored, {});
let notifications = 0;
directory.notify = () => notifications++;
const models = builtinModels({ credentials: directoryCredentials(directory) });
assert.deepEqual(plain(await directory.defaultAgent()), {});
for (const provider of ["anthropic", "openrouter", "github-copilot", "openai"]) {
  const catalog = models.getModels(provider), chosen = catalog.at(-1);
  assert(catalog.length > 1, provider);
  await directory.setCredential(provider, provider === "github-copilot"
    ? { type: "oauth", access: "test", availableModelIds: [chosen.id] }
    : { type: "api_key", key: "test" });
  const agent = { model: { provider, modelId: chosen.id }, thinkingLevel: getSupportedThinkingLevels(chosen).at(-1) };
  const before = notifications;
  assert.deepEqual(plain((await directory.setDefaultAgent(agent)).agent), agent);
  assert.equal(notifications, before + 1, "subscribers notified");
  assert.deepEqual(plain(await directory.defaultAgent()), agent);
  if (provider === "github-copilot") {
    assert.match((await directory.setDefaultAgent({ model: { provider, modelId: catalog[0].id } })).error, /not available/);
    assert.deepEqual(plain(await directory.defaultAgent()), agent, "respect credential filtering");
  }
}
const saved = plain(await directory.defaultAgent());
for (const agent of [null, [], {}, { model: null }, { model: [] }, { model: {} },
  { model: { provider: "", modelId: "x" } }, { model: { provider: "openai", modelId: " " } },
  { ...saved, extra: true }, { ...saved, model: { ...saved.model, extra: true } },
  { ...saved, thinkingLevel: null }, { ...saved, thinkingLevel: 1 }, { ...saved, thinkingLevel: "not-a-level" },
  { model: { provider: "unknown", modelId: saved.model.modelId } },
  { model: { provider: "anthropic", modelId: saved.model.modelId } },
  { model: { provider: "openai", modelId: "absent" } },
  { model: { provider: "google", modelId: models.getModels("google")[0].id } },
]) {
  assert.equal(typeof (await directory.setDefaultAgent(agent)).error, "string", JSON.stringify(agent));
  assert.deepEqual(plain(await directory.defaultAgent()), saved, "rejection leaves default unchanged");
}
const omitted = { model: saved.model };
assert.deepEqual(plain((await directory.setDefaultAgent(omitted)).agent), omitted);
directory = new Directory(stored, {});
assert.deepEqual(plain(await directory.defaultAgent()), omitted, "survives reload");
await directory.logout("anthropic");
assert.deepEqual(plain(await directory.defaultAgent()), omitted, "unrelated logout keeps default");
await directory.logout(saved.model.provider);
assert.deepEqual(plain(await directory.defaultAgent()), {}, "matching logout clears default");
// A catalog ID shared by two providers is not available under both credentials.
const sharedId = models.getModels("anthropic").find((m) => models.getModel("github-copilot", m.id))?.id;
assert(sharedId);
assert.equal(typeof (await directory.setDefaultAgent({ model: { provider: "github-copilot", modelId: sharedId } })).error, "string");

for (const provider of ["openai", "openai-codex", "anthropic", "openrouter", "github-copilot"]) {
  for (const available of [[], [{ id: "first", reasoning: false }],
    [{ id: "first", reasoning: true }, { id: "gpt-6-astra", reasoning: true }]]) {
    const cell = new Directory(state(), {});
    await cell.setCredential(provider, { type: "api_key", key: "test" });
    await cell.connected({ getAvailable: async (id) => { assert.equal(id, provider); return available; } }, provider);
    const preferred = provider === "openai" || provider === "openai-codex";
    const selected = (preferred && available.find((m) => m.id === "gpt-6-astra")) || available[0];
    const expected = selected ? { model: { provider, modelId: selected.id }, thinkingLevel: selected.reasoning ? "high" : "off" } : {};
    assert.deepEqual(plain(await cell.defaultAgent()), expected);
    if (selected) {
      await cell.connected({ getAvailable() { throw new Error("must not replace default"); } }, "another-provider");
      assert.deepEqual(plain(await cell.defaultAgent()), expected);
    }
  }
}
{
  const cell = new Directory(state(), {}), pending = Promise.withResolvers();
  const connecting = cell.connected({ getAvailable: () => pending.promise }, "openai");
  await cell.setCredential("anthropic", { type: "api_key", key: "test" });
  const selected = { model: { provider: "anthropic", modelId: models.getModels("anthropic")[0].id } };
  assert.deepEqual(plain((await cell.setDefaultAgent(selected)).agent), selected);
  pending.resolve([{ id: "gpt-6-astra", reasoning: true }]);
  await connecting;
  assert.deepEqual(plain(await cell.defaultAgent()), selected, "user choice wins over a pending bootstrap");
}
{
  const cell = new Directory(state(), {}), pending = Promise.withResolvers();
  cell.notify = () => {};
  await cell.setCredential("openai", { type: "api_key", key: "test" });
  const connecting = cell.connected({ getAvailable: () => pending.promise }, "openai");
  await cell.logout("openai");
  pending.resolve([{ id: "gpt-6-astra", reasoning: true }]);
  await connecting;
  assert.deepEqual(plain(await cell.defaultAgent()), {}, "logout wins over a pending bootstrap");
}
{
  const cell = new Directory(state(), {});
  cell.notify = () => {};
  await cell.setCredential("anthropic", { type: "api_key", key: "test" });
  // Sign out after the catalog lookup validated the model, before the write.
  const storage = cell.state.storage, transaction = storage.transaction;
  storage.transaction = async (fn) => { storage.transaction = transaction; await cell.logout("anthropic"); return transaction(fn); };
  const result = await cell.setDefaultAgent({ model: { provider: "anthropic", modelId: models.getModels("anthropic")[0].id } });
  assert.match(result.error, /disconnected/);
  assert.deepEqual(plain(await cell.defaultAgent()), {}, "logout wins over a pending save");
}

// Real Session initialization: inherit once, preserve a local choice on
// reopen, and retain the model-less pre-login fallback.
{
  const models = createModels();
  models.setProvider(fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }] }).provider);
  const { Session, Directory } = await load({
    "@cloudflare/sandbox": { getSandbox() { throw new Error("must not wake sandbox"); } },
    "@earendil-works/pi-durable": durable,
    "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage },
    "@earendil-works/pi-durable/tools": { CodingTools },
    "@earendil-works/pi-ai": { Type },
    "@earendil-works/pi-ai/models": { getSupportedThinkingLevels },
    "@earendil-works/pi-ai/providers/all": { builtinModels: () => models },
    "@earendil-works/chord/context": { BACKGROUND_CONTEXT: ctx },
    "./cell-sqlite.js": { CellSqlite },
    "./artifacts.js": { ARTIFACT_KINDS: ["markdown"], Artifacts: class {} },
  }, { setTimeout, clearTimeout });
  const cells = [], directory = new Directory(state(), {});
  directory.notify = () => {};
  const env = { DIRECTORY: { getByName: () => directory }, ARTIFACTS: { getByName: () => ({}) } };
  const agent = (modelId) => ({ model: { provider: "faux", modelId }, thinkingLevel: "off" });
  async function make(id) {
    const cell = new Session(state(), env);
    cells.push(cell);
    cell.workspace = async () => ({ async prepare() {} });
    await cell.init({ id, name: id, cwd: "/workspace", createdAt: 1, titled: true });
    return cell;
  }
  async function close(cell) {
    if (!cell.opening) return;
    const opened = await cell.opening;
    await opened.status.stop();
    await opened.harness.close(ctx);
    cell.opening = null;
  }
  const configuration = async (cell) => plain(await (await cell.open()).root.agent(ctx));
  try {
    const preLogin = await make("pre-login");
    assert.equal((await configuration(preLogin)).model, undefined);
    await close(preLogin);
    await directory.setDefaultAgent(agent("faux-1"));
    const existing = await make("existing");
    assert.deepEqual((await configuration(existing)).model, agent("faux-1").model);
    await (await existing.open()).root.configure(agent("faux-2"), ctx);
    await directory.setDefaultAgent(agent("faux-3"));
    assert.deepEqual((await configuration(existing)).model, agent("faux-2").model, "open Session is unchanged");
    await close(existing);
    assert.deepEqual((await configuration(existing)).model, agent("faux-2").model, "reopen preserves local choice");
    const fresh = await make("fresh");
    assert.deepEqual((await configuration(fresh)).model, agent("faux-3").model, "new Session inherits latest default");
    assert.equal((await configuration(fresh)).thinkingLevel, "off");
    assert.deepEqual((await configuration(preLogin)).model, agent("faux-3").model, "model-less Session acquires default");
  } finally {
    for (const cell of cells) await close(cell);
  }
}
for (const value of states) value.db.close();
console.log("default-agent.check ok");
