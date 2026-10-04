// Routing/lifecycle self-check without celld: node --experimental-vm-modules terminal.check.mjs
import assert from "node:assert/strict";
import { load } from "./check-harness.mjs";

const upgrade = { status: 101, webSocket: {} };
const meta = { id: "abc-123", cwd: "/workspace/repo" };
let creationError;
let calls = [];
let forwarded;
const sandbox = {
  async createSession(options) {
    calls.push(["create", options]);
    if (creationError) throw creationError;
  },
  async getSession(id) {
    calls.push(["get", id]);
    return { terminal(request, options) { forwarded = request; calls.push(["pty", options]); return upgrade; } };
  },
};
// Only the route is exercised; Harness and container services are boundaries.
const { Session, default: worker } = await load({
  "@cloudflare/sandbox": { getSandbox: () => sandbox, Sandbox: class {} },
  "./directory.js": { Directory: class {} },
});
const cell = new Session();
cell.env = { Sandbox: {}, DIRECTORY: { getByName: () => ({}) } };
cell.meta = async () => meta;
cell.open = async () => ({ root: {}, workspace: Promise.resolve() });
cell.workspace = async () => { calls.push(["workspace"]); };
const env = { SESSION: { getByName(id) { assert.equal(id, meta.id); return cell; } } };
const request = new Request(`https://example.test/api/session/${meta.id}/terminal`, { headers: { Upgrade: "websocket" } });

for (const error of [undefined, { code: "SESSION_ALREADY_EXISTS" }, { name: "SessionAlreadyExistsError" }]) {
  creationError = error;
  calls = [];
  assert.equal(await worker.fetch(request, env), upgrade, "return the exact upgrade response");
  assert.equal(forwarded, request, "forward the browser request, including Upgrade");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["workspace"], ["create", { id: "terminal-abc-123", cwd: meta.cwd }],
    ["get", "terminal-abc-123"], ["pty", { cols: 80, rows: 24, shell: "/bin/bash" }],
  ]);
}
creationError = new Error("container unavailable");
assert.equal((await worker.fetch(request, env)).status, 500, "don't swallow setup errors");
assert.equal((await worker.fetch(new Request(request.url), env)).status, 426);
assert.equal((await worker.fetch(new Request(request.url, { method: "POST" }), env)).status, 404);
cell.meta = async () => null;
assert.equal((await worker.fetch(request, env)).status, 404);
console.log("terminal.check ok");
