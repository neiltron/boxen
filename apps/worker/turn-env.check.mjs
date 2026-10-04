// node --experimental-vm-modules turn-env.check.mjs
// A turn's tool env joins the workspace prepare through an RPC to its own
// cell, never by awaiting the shared prepare directly (session.js, the env
// option of openHarness, says why). This checks the routing only: the vm has
// no celld, so it cannot show the direct join hanging.
import assert from "node:assert/strict";
import { load } from "./check-harness.mjs";

let options;
const { Session } = await load({
  "@cloudflare/sandbox": { getSandbox() {} },
  "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
  "@earendil-works/pi-durable": {
    createRegistry: () => ({ install() {} }), defineExtension: (x) => x, defineTool() {}, section() {}, watchEvents() {},
    Harness: { async open(storage, o) { options = o; throw new Error("stop: options captured"); } },
  },
  "@earendil-works/pi-durable/storage/sqlite": { SqliteStorage: { async open() {} } },
});

const calls = [];
const env = {
  DIRECTORY: { getByName: () => ({}) },
  ARTIFACTS: { getByName: () => ({}) },
  SESSION: { getByName: (name) => ({ prepareWorkspace: async () => { calls.push(`rpc ${name}`); } }) },
};
const cell = new Session({ id: "cell", storage: { get: async () => ({ id: "abc-123", cwd: "/workspace" }) } }, env);
cell.workspace = async () => ({
  prepare: async () => { calls.push("prepare"); },
  env: async (cwd) => { calls.push(`env ${cwd}`); return { cwd }; },
});
await assert.rejects(cell.openHarness(), /stop: options captured/);

assert.deepEqual(await options.env({ cwd: "/workspace/app" }), { cwd: "/workspace/app" });
assert.deepEqual(calls, ["rpc abc-123", "env /workspace/app"], "the turn's env first joins the prepare by RPC to its own cell");
calls.length = 0;
await cell.prepareWorkspace();
assert.deepEqual(calls, ["prepare"], "the RPC's handler is the one that waits on the prepare");
console.log("turn-env.check ok (a turn's env joins the workspace prepare by RPC to its own cell)");
