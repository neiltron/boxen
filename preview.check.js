// Run with node preview.check.js; no celld or container required.
import assert from "node:assert/strict";
import { previewTarget, validPreviewPort, proxyPreview, listeningPorts } from "./src/preview.js";

const id = "12345678-1234-4567-89ab-123456789abc";
const host = `p5173-${id}.localhost:8093`;
assert.deepEqual(previewTarget(host), { port: 5173, id });
assert.deepEqual(previewTarget(host.toUpperCase()), { port: 5173, id });
assert.deepEqual(previewTarget(`p65535-${id}.localhost`), { port: 65535, id });
for (const host of ["localhost:8093", "127.0.0.1:8093", `p5173-${id}.localhost.evil:8093`, "p5173-not-a-uuid.localhost"]) {
  assert.equal(previewTarget(host), null);
}
for (const port of [0, 80, 1023, 3000, 65536, 999999999999999999999, NaN, 5173.5]) assert.equal(validPreviewPort(port), false);
for (const port of [1024, 3001, 5173, 65535]) assert.equal(validPreviewPort(port), true);
for (const port of [0, 1023, 3000, 65536]) {
  assert.equal(validPreviewPort(previewTarget(`p${port}-${id}.localhost:8093`).port), false);
}

// Host routing leaves app paths, headers, bodies, statuses and redirects alone.
for (const method of ["GET", "POST", "OPTIONS"]) {
  const request = new Request(`http://${host}/api/app?q=hello%20world`, {
    method, headers: { host, "x-app": "kept" }, ...(method === "POST" ? { body: "payload" } : {}),
  });
  const response = new Response("upstream", { status: 307, headers: { location: "/login" } });
  const result = await proxyPreview(request, {
    async containerFetch(forwarded, port) {
      assert.equal(port, 5173);
      assert.equal(forwarded.url, request.url);
      assert.equal(forwarded.method, method);
      assert.equal(forwarded.headers.get("host"), host);
      assert.equal(forwarded.headers.get("x-app"), "kept");
      assert.equal(forwarded.redirect, "manual");
      if (method === "POST") assert.equal(await forwarded.text(), "payload");
      return response;
    },
  }, 5173);
  assert.equal(result, response);
}
const upgrade = new Request(`http://${host}/hmr?token=abc`, {
  headers: { host, Upgrade: "WebSocket", "Sec-WebSocket-Protocol": "vite-hmr", "x-sandbox-preview-proxy": "1", "x-sandbox-name": "other" },
});
// Node's Response cannot construct status 101; identity verifies no wrapping.
const upgraded = { status: 101, webSocket: {} };
assert.equal(await proxyPreview(upgrade, {
  async wsConnect(request, port) {
    assert.equal(request.url, upgrade.url);
    assert.equal(request.headers.get("connection"), "Upgrade");
    assert.equal(request.headers.get("sec-websocket-protocol"), "vite-hmr");
    assert.equal(request.headers.get("host"), host);
    assert.equal(request.headers.has("x-sandbox-preview-proxy"), false);
    assert.equal(request.headers.has("x-sandbox-name"), false);
    assert.equal(port, 5173);
    return upgraded;
  },
}, 5173), upgraded);
const failed = await proxyPreview(new Request(`http://${host}/`), {
  async containerFetch() { throw new Error("connection refused"); },
}, 5173);
assert.equal(failed.status, 502);
assert.match(await failed.text(), /connection refused/);

assert.deepEqual(await listeningPorts({
  async exec(command, options) {
    assert.match(command, /^bash -c /);
    assert.equal(options.timeout, 5000);
    return { success: true, stdout: `  sl  local_address rem_address st
      0: 00000000:1435 00000000:0000 0A
      1: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A
      2: 00000000:0BB8 00000000:0000 0A
      3: 00000000:0050 00000000:0000 0A
      4: 00000000:1F90 00000000:0000 01
      5: 00000000:0400 00000000:0000 0A
      6: 00000000:FFFF 00000000:0000 0A\n` };
  },
}), [1024, 5173, 65535]);
await assert.rejects(listeningPorts({ async exec() { return { success: false, stderr: "unavailable" }; } }), /unavailable/);
console.log("preview checks passed");
