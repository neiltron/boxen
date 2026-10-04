// node --experimental-vm-modules contract.check.mjs
// The router against the API contract (@pi-durable-sessions/client's
// openapi.json), with the real Directory on in-memory SQLite. Every request
// is checked against the spec's schemas, and the method probes fail on drift
// either way: a route the worker serves that the spec lacks, or the reverse.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Ajv from "ajv/dist/2020.js";
import { apiClient } from "@pi-durable-sessions/client";
import spec from "@pi-durable-sessions/client/openapi.json" with { type: "json" };
import { load } from "./check-harness.mjs";

// API paths the spec must cover. ponytail: a new path outside this list and
// the spec goes unnoticed; #71 makes it every path the worker serves.
const COVERED = ["/api/sessions"];
// Every method an OpenAPI path item can declare, except OPTIONS: the router
// answers every OPTIONS preflight with CORS headers, before any route.
const METHODS = ["GET", "PUT", "POST", "DELETE", "HEAD", "PATCH", "TRACE"];

const { default: worker, Directory } = await load({
  "@cloudflare/sandbox": { getSandbox() { throw new Error("must not wake sandbox"); } },
  "./session.js": { Session: class {} },
}, { crypto, setTimeout: () => 1 });
const db = new DatabaseSync(":memory:");
const directory = new Directory({ storage: { sql: { exec(sql, ...params) {
  const rows = db.prepare(sql).all(...params);
  return { toArray: () => rows };
} } } }, {});
const env = {
  DIRECTORY: { getByName: () => directory },
  // What Session.init does outside its own cell.
  SESSION: { getByName: () => ({ init: (meta) => directory.register(meta) }) },
};

const ajv = new Ajv({ strict: false }); // the OpenAPI keywords around the schemas aren't JSON Schema
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const deref = (o) => (o?.$ref ? deref(o.$ref.slice(2).split("/").reduce((x, k) => x[k], spec)) : o);
function conforms(schema, value, what) {
  const validate = ajv.compile({ ...schema, components: spec.components });
  assert.ok(validate(value), `${what}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

// The router's fallthrough: no route matched.
const unrouted = async (response) => response.status === 404 &&
  (await response.clone().json().catch(() => ({}))).error === "unknown route";

// The worker, with each request and response held to the spec.
async function call(request, environment = env) {
  const { pathname } = new URL(request.url);
  const op = spec.paths[pathname]?.[request.method.toLowerCase()];
  const what = `${request.method} ${pathname}`;
  const body = op?.requestBody && await request.clone().text();
  const response = await worker.fetch(request, environment);
  if (!op) return response;
  assert.ok(!await unrouted(response), `${what} is in openapi.json but the worker doesn't serve it`);
  const schema = deref(op.requestBody)?.content["application/json"].schema;
  // Requests the worker accepted must be ones the spec allows.
  if (schema && response.status < 400) conforms(schema, JSON.parse(body), `${what} request`);
  const expected = deref(op.responses[response.status]);
  assert.ok(expected, `${what} answered ${response.status}, which the spec doesn't list`);
  conforms(expected.content["application/json"].schema, await response.clone().json(), `${what} ${response.status}`);
  return response;
}

// Through the typed client, as the web app calls it.
const client = apiClient("http://localhost:8093", (request) => call(request));
const repo = await client.createSession({ repo: " https://github.com/neiltron/celld-test.git ", branch: "main" });
assert.equal(repo.name, "celld-test");
assert.equal(repo.cwd, "/workspace/celld-test");
assert.equal(repo.titled, false);
const named = await client.createSession({ name: "Named", repo: "", branch: "" });
assert.equal(named.titled, true);
assert.equal(named.repo, undefined);
const list = await client.listSessions();
assert.deepEqual(list.map((s) => s.id).sort(), [repo.id, named.id].sort());
assert.equal(list.find((s) => s.id === repo.id).status, "idle");

// Error responses.
const post = (body) => new Request("http://localhost:8093/api/sessions", { method: "POST", body });
assert.equal((await call(post("not json"))).status, 500);
const broken = { ...env, DIRECTORY: { getByName: () => ({ list() { throw new Error("directory offline"); } }) } };
assert.equal((await call(new Request("http://localhost:8093/api/sessions"), broken)).status, 500);
await assert.rejects(apiClient("http://localhost:8093", (r) => call(r, broken)).listSessions(), /directory offline/);

// Drift: the worker serves exactly the methods the spec lists, on every
// covered path and every path in the spec (call() fails on listed but unrouted).
for (const path of new Set([...COVERED, ...Object.keys(spec.paths)])) {
  for (const method of METHODS) {
    // fetch forbids TRACE, so no client can send one and no worker receives one.
    if (method === "TRACE") {
      assert.ok(!spec.paths[path]?.trace, `TRACE ${path} is in openapi.json but fetch can't send it`);
      continue;
    }
    const body = method === "GET" || method === "HEAD" ? undefined : "{}";
    const response = await call(new Request(`http://localhost:8093${path}`, { method, body }));
    const listed = !!spec.paths[path]?.[method.toLowerCase()];
    assert.ok(listed || await unrouted(response), `${method} ${path} is served by the worker but missing from openapi.json`);
  }
}
console.log("contract.check ok");
