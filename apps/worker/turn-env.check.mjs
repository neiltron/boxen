// node --experimental-vm-modules turn-env.check.mjs
// A turn's tool env waits for the workspace prepare only inside an RPC to its
// own cell, never on a shared prepare directly (session.js, the env option of
// openHarness, says why). Real Session and workspace modules, a fake Sandbox
// whose prepare the check settles by hand. The vm has no celld, so it cannot
// show a direct join hanging; it shows which promises the turn awaits.
import assert from "node:assert/strict";
import { load } from "./check-harness.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settled = async (promise) => {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return done;
};

let prepares = []; // the fake Sandbox's prepare calls, each settled by the check
const sandbox = { prepare() { const d = deferred(); prepares.push(d); return d.promise; } };
let options;
const { Session } = await load({
  "@cloudflare/sandbox": { getSandbox: () => sandbox },
  "./sandbox-env.js": { sandboxEnv: (sb, id, cwd) => ({ cwd }), shellQuote() {} },
  "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
  "@earendil-works/pi-durable": {
    SessionFailed: class extends Error {}, createRegistry: () => ({ install() {} }), defineExtension: (x) => x, defineTool() {}, hook() {}, section() {}, ToolTask: {}, watchEvents() {},
    Harness: { async open(storage, o) { options = o; throw new Error("stop: options captured"); } },
  },
  "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage: { async open() {} } },
});

let rpc = null; // the pending RPC to the cell's own prepareWorkspace
let secretsRead = 0;
const env = {
  DIRECTORY: { getByName: () => ({ secrets: async () => { secretsRead++; return {}; } }) },
  ARTIFACTS: { getByName: () => ({}) },
  SESSION: { getByName: (name) => ({ prepareWorkspace: () => { assert.equal(name, "abc-123"); rpc = deferred(); return rpc.promise; } }) },
};
const cell = new Session({ id: "cell", storage: { get: async () => ({ id: "abc-123", cwd: "/workspace" }) } }, env);
await assert.rejects(cell.openHarness(), /stop: options captured/);
const ws = await cell.workspace();

// The RPC's handler stays pending until preparation finishes.
{
  const call = cell.prepareWorkspace();
  assert.equal(await settled(call), false, "prepareWorkspace waits for the prepare");
  assert.equal(prepares.length, 1);
  prepares[0].resolve("ready");
  await call;
  prepares = [];
}

// The env is not built while the RPC is pending.
{
  const building = options.env({ cwd: "/workspace/app" });
  assert.equal(await settled(building), false);
  assert.ok(rpc, "the turn's env asks its own cell to prepare");
  assert.equal(secretsRead, 0, "nothing of the env before the RPC answers");
  assert.equal(prepares.length, 0, "the turn starts no prepare of its own");
  rpc.resolve();
  assert.deepEqual(await building, { cwd: "/workspace/app" });
  assert.equal(secretsRead, 1);
}

// A prepare another caller starts between the RPC's reply and the env's
// construction (the web app polls Changes) is not awaited by the turn.
{
  const building = options.env({ cwd: "/workspace" });
  await settled(building);
  rpc.resolve();
  const other = ws.prepare(); // a diff request's, still running
  assert.equal(prepares.length, 1, "the other caller's prepare is in flight");
  assert.equal(await settled(building), true, "the turn does not join another caller's prepare");
  assert.deepEqual(await building, { cwd: "/workspace" });
  prepares[0].resolve("ready");
  await other;
}

// A failed prepare fails the env: a tool call doesn't run without its repo.
{
  const building = options.env({ cwd: "/workspace" });
  await settled(building);
  rpc.reject(new Error("fatal: repository not found"));
  await assert.rejects(building, /not found/);
}
console.log("turn-env.check ok (a turn's env waits for the prepare only inside an RPC to its own cell)");
