// The phone's cell end to end in Node: SQLite's WebAssembly build behind
// WasmSqlite, pi-durable's SqliteStorage, a faux model, and the shared
// session client over an in-process transport. Run: node cell.check.ts
import assert from "node:assert/strict";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { sessionClient, type Transport } from "@boxen/client";
import { openAgent, serve } from "./src/cell.ts";
import { WasmSqlite } from "./src/wasm-sqlite.ts";

const sqlite3 = await sqlite3InitModule();
const db = new WasmSqlite(new sqlite3.oo1.DB(":memory:"));
db.close = async () => {}; // so a closed Harness can reopen over the same in-memory database
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

const agent = await openAgent(await SqliteStorage.open(db), models);
await agent.root.configure({ model: { provider: model.provider, modelId: model.id } }, ctx);

// The worker transport's shape, without the worker: frames as JSON strings both ways.
const transportFor = (connect: ReturnType<typeof serve>): Transport => (_url, on) => {
  const conn = connect((frame) => on.message(JSON.stringify(frame)));
  queueMicrotask(on.open);
  return { send: (data) => conn.message(data), close: () => conn.close() };
};

const client = sessionClient("local:", { transport: transportFor(serve(Promise.resolve(agent))) });
const stop = client.connect();

faux.setResponses([fauxAssistantMessage("Paris.")]);
assert.deepEqual(await client.run("Capital of France?"), { status: "done", text: "Paris." });
assert.equal(client.state().meta?.name, "On this phone");

client.listModels();
await new Promise((r) => setTimeout(r, 50));
assert.ok(client.state().models?.some((m) => m.id === model.id), "the faux model is listed");
stop();
await agent.harness.close(ctx);

// As after the page is killed: a Harness reopened over the same database, and
// a fresh join's snapshot carries the transcript.
const reopened = await openAgent(await SqliteStorage.open(db), models);
const again = sessionClient("local:", { transport: transportFor(serve(Promise.resolve(reopened))) });
const stopAgain = again.connect();
await new Promise((r) => setTimeout(r, 50));
assert.deepEqual(again.state().model.items.map((i) => i.kind), ["user", "assistant"]);
stopAgain();
await reopened.harness.close(ctx);
console.log("cell.check: ok");
