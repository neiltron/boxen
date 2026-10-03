// node --experimental-vm-modules assets.check.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const context = createContext({ Request, Response, URL, atob, console });
const stubs = {
  "@earendil-works/pi-ai/bun-oauth": { registerBunOAuthFlows() {} },
  "@cloudflare/sandbox": { Sandbox: class {}, getSandbox() { throw new Error("unexpected sandbox"); } },
  "./artifacts.js": { Artifacts: class {} },
  "./directory.js": { Directory: class {} },
  "./session.js": { Session: class {} },
};
const entry = new SourceTextModule(await readFile(new URL("src/index.js", import.meta.url), "utf8"), { context });
await entry.link(async (name) => {
  if (name === "./preview.js") {
    const module = new SourceTextModule(await readFile(new URL("src/preview.js", import.meta.url), "utf8"), { context });
    await module.link(() => { throw new Error("unexpected import"); });
    return module;
  }
  const values = stubs[name];
  return new SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
});
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
const host = "p5173-11111111-1111-4111-8111-111111111111.localhost:8093";
const previewEnv = { ...env, SESSION: { getByName() { return { meta: async () => null }; } } };
const missingPreview = await worker.fetch(new Request(`http://${host}/`, { headers: { host } }), previewEnv);
assert.equal(missingPreview.status, 404);
assert.equal(await missingPreview.text(), "no such session");
assert.equal(calls, 3, "API/preview/mutating requests never fall through to the SPA");
console.log("assets.check ok");
