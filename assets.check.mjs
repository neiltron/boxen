// node --experimental-vm-modules assets.check.mjs
// Worker routing: installed UI assets, and the session routes that reach a Sandbox.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const context = createContext({ Request, Response, URL, Headers, atob, console });
let sandbox; // what getSandbox hands the workspace module
const stubs = {
  "@earendil-works/pi-ai/bun-oauth": { registerBunOAuthFlows() {} },
  "@cloudflare/sandbox": { getSandbox(binding, id) { return sandbox(binding, id); } },
  "./sandbox-env.js": { sandboxEnv() {}, shellQuote() {} },
  "./sandbox.js": { Sandbox: class {} },
  "./artifacts.js": { Artifacts: class {} },
  "./directory.js": { Directory: class {} },
  "./session.js": { Session: class {} },
};
async function link(name) {
  if (name === "./workspace.js") {
    const module = new SourceTextModule(await readFile(new URL("src/workspace.js", import.meta.url), "utf8"), { context });
    await module.link(link);
    return module;
  }
  const values = stubs[name];
  return new SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
}
const entry = new SourceTextModule(await readFile(new URL("src/index.js", import.meta.url), "utf8"), { context });
await entry.link(link);
await entry.evaluate();
const worker = entry.namespace.default;
let forwarded;
let calls = 0;
const assetResponse = new Response("<html>installed UI</html>");
const env = { ASSETS: { fetch(request) { calls++; forwarded = request; return assetResponse; } } };
for (const [path, method] of [["/", "GET"], ["/assets/app.js", "GET"], ["/deep/link", "HEAD"]]) {
  const request = new Request(`http://localhost:8093${path}`, { method });
  assert.equal(await worker.fetch(request, env), assetResponse);
  assert.equal(forwarded, request);
}
assert.equal(calls, 3);
for (const path of ["/api", "/api/no-such-endpoint"]) {
  const response = await worker.fetch(new Request(`http://localhost:8093${path}`, {
    headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
  }), env);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "unknown route");
}
assert.equal((await worker.fetch(new Request("http://localhost:8093/", { method: "POST" }), env)).status, 404);
assert.equal((await worker.fetch(new Request("http://localhost:8093/"), {})).status, 404, "dev mode stays unchanged");

// An unknown session gets a 404 on every Sandbox route, before any cell
// method runs or a container boots.
const id = "11111111-1111-4111-8111-111111111111";
const host = `p5173-${id}.localhost:8093`;
const api = (route, init) => new Request(`http://localhost:8093/api/session/${id}/${route}`, init);
const upgrade = { headers: { Upgrade: "websocket" } };
sandbox = () => { throw new Error("no sandbox for an unknown session"); };
const unknown = { ...env, SESSION: { getByName() {
  return { meta: async () => null, diff() { throw new Error("unexpected diff"); }, fetch() { throw new Error("unexpected fetch"); } };
} } };
const missingPreview = await worker.fetch(new Request(`http://${host}/`, { headers: { host } }), unknown);
assert.equal(missingPreview.status, 404);
assert.equal(await missingPreview.text(), "no such session");
for (const route of ["diff", "ports", "terminal"]) {
  const response = await worker.fetch(api(route, upgrade), unknown);
  assert.equal(response.status, 404, route);
  assert.equal((await response.json()).error, "no such session");
}

// An existing session: diff and the terminal go to its cell, ports to its Sandbox.
const session = {
  meta: async () => ({ id, cwd: "/workspace" }),
  diff: async () => ({ repo: false, patch: "" }),
  fetch: (request) => ({ status: 101, webSocket: {}, request }), // Node's Response can't be 101
};
const existing = { ...env, Sandbox: {}, SESSION: { getByName(name) { assert.equal(name, id); return session; } } };
sandbox = (binding, name) => {
  assert.equal(binding, existing.Sandbox);
  assert.equal(name, id);
  return { exec: async () => ({ success: true, stdout: "0: 00000000:1435 00000000:0000 0A" }) };
};
assert.deepEqual(await (await worker.fetch(api("diff"), existing)).json(), { repo: false, patch: "" });
assert.deepEqual(await (await worker.fetch(api("ports"), existing)).json(), { ports: [5173] });
const terminal = api("terminal", upgrade);
assert.equal((await worker.fetch(terminal, existing)).request, terminal, "forward the browser request, including Upgrade");
session.fetch = () => { throw new Error("container unavailable"); };
assert.equal((await worker.fetch(terminal, existing)).status, 500, "don't swallow setup errors");
for (const route of ["terminal", "ws"]) assert.equal((await worker.fetch(api(route), existing)).status, 426, route);
for (const route of ["diff", "ports", "terminal"]) {
  assert.equal((await worker.fetch(api(route, { method: "POST" }), existing)).status, 404, `POST ${route}`);
}
assert.equal(calls, 3, "API/preview/mutating requests never fall through to the SPA");
console.log("assets.check ok");
