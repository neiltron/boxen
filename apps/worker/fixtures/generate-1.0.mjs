// Regenerate only with an isolated, exact 1.0.0 install. This is not run in CI.
// npm install --prefix /tmp/pds-legacy @earendil-works/pi-durable@1.0.0 @earendil-works/pi-ai@1.0.0 @earendil-works/chord@1.0.0
// node fixtures/generate-1.0.mjs /tmp/pds-legacy/node_modules
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const load = async (name) => {
  const parts = name.split("/");
  const base = resolve(process.argv[2], parts.slice(0, 2).join("/"));
  const pkg = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
  assert.equal(pkg.version, "1.0.0");
  const key = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
  const target = pkg.exports[key] ?? { import: `./dist/${parts.slice(2).join("/")}.js` };
  return import(pathToFileURL(join(base, typeof target === "string" ? target : target.import ?? target.default)));
};
const { Harness, createRegistry, defineTool, defineExtension } = await load("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await load("@earendil-works/pi-durable/storage/sqlite/node");
const { Type } = await load("@earendil-works/pi-ai");
const { createModels } = await load("@earendil-works/pi-ai/models");
const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await load("@earendil-works/pi-ai/providers/faux");
const { BACKGROUND_CONTEXT: ctx } = await load("@earendil-works/chord/context");
const dir = await mkdtemp(join(tmpdir(), "pds-legacy-"));
const path = join(dir, "store.sqlite");
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("fixture", { hold: false }, { id: "old-done" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText("old answer")]),
  fauxAssistantMessage([fauxToolCall("fixture", { hold: true }, { id: "old-pending" })], { stopReason: "toolUse" }),
]);
const entered = Promise.withResolvers();
const registry = createRegistry();
registry.install(defineExtension({ name: "fixture", tools: [defineTool({
  name: "fixture", description: "Migration test", replay: "safe", parameters: Type.Object({ hold: Type.Boolean() }),
  async execute(args, api, context) {
    if (args.hold) {
      await api.output("old partial", context);
      entered.resolve();
      await new Promise((resolve) => context.abortSignal.addEventListener("abort", resolve, { once: true }));
    }
    return { content: [{ type: "text", text: "old tool output" }], details: { artifactId: "legacy-artifact" } };
  },
})] }));
const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, ctx);
const root = await harness.root(ctx, { agent: { cwd: "/workspace", model: { provider: "faux", modelId: "faux-1" } } });
await (await root.submit({ type: "input", content: "completed input", requestId: "old-completed" }, ctx)).wait(ctx);
await root.submit({ type: "write", entry: { kind: "app.note", data: { text: "old display note" } } }, ctx);
await root.submit({ type: "input", content: "pending input", requestId: "old-pending" }, ctx);
await entered.promise;
await root.submit({ type: "input", content: "queued input", requestId: "old-queued", whenBusy: "followUp" }, ctx);
// Dump a consistent committed database while the old tool is still running.
// This models a process loss, not a graceful turn completion.
const db = new DatabaseSync(path);
const schema = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name").all();
const fixture = { runtime: "1.0.0", root: root.id, schema, tables: {} };
for (const row of schema.filter((r) => r.type === "table")) fixture.tables[row.name] = db.prepare(`SELECT * FROM "${row.name}"`).all();
await writeFile(new URL("pi-durable-1.0.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
db.close();
await harness.close(ctx);
await rm(dir, { recursive: true, force: true });
console.log("wrote real 1.0.0 committed history, running tool, and queued input");
