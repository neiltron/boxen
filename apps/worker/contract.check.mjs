// node --experimental-vm-modules contract.check.mjs
// The router against the API contract (@boxen/client's
// openapi.json), with the real Directory, Artifacts and Session cells on
// in-memory SQLite. The worker routes from the spec, so it serves no API
// route the spec lacks; this drives every operation the other way, holds each
// request and response to the spec's schemas, and probes every method on
// every path so the worker serves exactly the methods the spec lists.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Ajv from "ajv/dist/2020.js";
import { apiClient, validPreviewPort } from "@boxen/client";
import spec from "@boxen/client/openapi.json" with { type: "json" };
import { load } from "./check-harness.mjs";

// Every method an OpenAPI path item can declare, except OPTIONS: the router
// answers every OPTIONS preflight with CORS headers, before any route.
const METHODS = ["GET", "PUT", "POST", "DELETE", "HEAD", "PATCH", "TRACE"];
const base = "http://localhost:8093";

// The boundaries past the cells: model providers and their sign-in, GitHub,
// and the Sandbox (only its listening ports are asked for).
const models = (credentials) => ({
  getProviders: () => [
    { id: "anthropic", name: "Anthropic", auth: { apiKey: { name: "ANTHROPIC_API_KEY" }, oauth: { name: "Claude Pro/Max" } } },
    { id: "openai", name: "OpenAI", auth: { apiKey: { name: "OPENAI_API_KEY" } } },
  ],
  getAvailable: async (provider) => [{ id: `${provider}-model` }],
  async login(provider, method, interaction) {
    if (provider !== "anthropic") throw new Error(`${provider} has no sign-in`);
    interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
    const redirect = await interaction.prompt();
    if (!new URL(redirect).searchParams.has("code")) throw new Error("the redirect has no code");
    await credentials.modify(provider, () => ({ type: "oauth", access: "token" }));
  },
});
async function github(url) {
  const { pathname } = new URL(url);
  if (pathname === "/user/repos") {
    return Response.json([{ full_name: "neiltron/celld-test", clone_url: "https://github.com/neiltron/celld-test.git",
      pushed_at: "2026-10-01T12:00:00Z", default_branch: "main", private: false }]);
  }
  if (pathname === "/repos/neiltron/celld-test") return Response.json({ default_branch: "main" });
  if (pathname === "/repos/neiltron/celld-test/branches") return Response.json([{ name: "dev" }, { name: "main" }]);
  return Response.json({ message: "Not Found" }, { status: 404 });
}
const listening = [80, 3000, 5173, 8080].map((p, i) => `${i}: 00000000:${p.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A`).join("\n");

const { default: worker, Directory, Artifacts, Session } = await load({
  "@cloudflare/sandbox": { getSandbox: () => ({ exec: async () => ({ success: true, stdout: listening }) }) },
  "@earendil-works/pi-ai/providers/all": { builtinModels: ({ credentials }) => models(credentials) },
  "./artifacts.js": undefined, // the real modules
  "./credentials.js": undefined,
}, { crypto, fetch: github, setTimeout: () => 1, setInterval: () => 1, clearInterval() {}, AbortController, TransformStream, TextEncoder });

function storage() {
  let values = new Map(), tail = Promise.resolve();
  const db = new DatabaseSync(":memory:");
  return {
    sql: { exec(sql, ...params) { const rows = db.prepare(sql).all(...params); return { toArray: () => rows }; } },
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    transaction(fn) {
      const run = tail.then(async () => {
        const before = structuredClone(values);
        try { return await fn(); } catch (e) { values = before; throw e; }
      });
      tail = run.catch(() => {});
      return run;
    },
  };
}
const directory = new Directory({ storage: storage() }, {});
const artifacts = new Artifacts({ storage: storage() }, {});
// Session cells without the agent: their workspace answers diff and terminal.
const workspace = {
  prepare: async () => {},
  diff: async () => ({ repo: true, patch: "diff --git a/README.md b/README.md\n" }),
  terminal: () => ({ status: 101, webSocket: {} }), // Node's Response can't be 101
};
const cells = new Map();
const env = {
  DIRECTORY: { getByName: () => directory },
  ARTIFACTS: { getByName: () => artifacts },
  SESSION: { getByName(id) {
    if (!cells.has(id)) cells.set(id, Object.assign(new Session({ storage: storage() }, env), { open: async () => {}, workspace: async () => workspace }));
    return cells.get(id);
  } },
};

const ajv = new Ajv({ strict: false }); // the OpenAPI keywords around the schemas aren't JSON Schema
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
ajv.addFormat("date-time", (s) => !Number.isNaN(Date.parse(s)));
const deref = (o) => (o?.$ref ? deref(o.$ref.slice(2).split("/").reduce((x, k) => x[k], spec)) : o);
function conforms(schema, value, what) {
  const validate = ajv.compile({ ...schema, components: spec.components });
  assert.ok(validate(value), `${what}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

// The router's fallthrough: no route matched.
const unrouted = async (response) => response.status === 404 &&
  (await response.clone().json().catch(() => ({}))).error === "unknown route";
// The spec path a pathname instantiates.
const template = (pathname) => Object.keys(spec.paths).find((path) =>
  new RegExp(`^${path.replace(/\{\w+\}/g, "[^/]+")}$`).test(pathname));

const called = new Set(); // operationIds driven below, other than by the probes
const streams = []; // NDJSON bodies still being checked line by line

// The worker, with each request and response held to the spec. A probe's
// body is a placeholder, so only its response is checked.
async function call(request, { environment = env, probe = false } = {}) {
  const { pathname } = new URL(request.url);
  const path = template(pathname);
  const op = spec.paths[path]?.[request.method.toLowerCase()];
  const what = `${request.method} ${path ?? pathname}`;
  const body = op?.requestBody && await request.clone().text();
  const response = await worker.fetch(request, environment);
  if (!op) return response;
  if (!probe) called.add(op.operationId);
  assert.ok(!await unrouted(response), `${what} is in openapi.json but the worker doesn't serve it`);
  const schema = deref(op.requestBody)?.content["application/json"].schema;
  // Requests the worker accepted must be ones the spec allows.
  if (schema && !probe && response.status < 400) conforms(schema, JSON.parse(body), `${what} request`);
  const expected = deref(op.responses[response.status]);
  assert.ok(expected, `${what} answered ${response.status}, which the spec doesn't list`);
  const [type, media] = Object.entries(expected.content ?? {})[0] ?? [];
  if (!type) return response; // 101: a socket, no body
  assert.equal(response.headers.get("content-type").split(";")[0], type, `${what} ${response.status}`);
  if (type === "application/json") conforms(media.schema, await response.clone().json(), `${what} ${response.status}`);
  if (type === "application/x-ndjson") {
    // The stream stays open until the sign-in ends: check a copy as it goes.
    const [mine, theirs] = response.body.tee();
    streams.push(new Response(mine).text().then((text) => {
      assert.ok(text.endsWith("\n"), `${what}: every line ends in \\n`);
      for (const line of text.slice(0, -1).split("\n")) conforms(media.schema, JSON.parse(line), `${what} line`);
    }));
    return new Response(theirs, response);
  }
  return response;
}

// Through the typed client, as the web app calls it.
const client = apiClient(base, (request) => call(request));

// Sessions.
const repo = await client.createSession({ repo: " https://github.com/neiltron/celld-test.git ", branch: "main" });
assert.equal(repo.name, "celld-test");
assert.equal(repo.cwd, "/workspace/celld-test");
assert.equal(repo.titled, false);
const named = await client.createSession({ name: "Named", repo: "", branch: "" });
assert.equal(named.titled, true);
assert.equal(named.repo, undefined);
let list = await client.listSessions();
assert.deepEqual(list.map((s) => s.id).sort(), [repo.id, named.id].sort());
assert.equal(list.find((s) => s.id === repo.id).status, "idle");
const renamed = await client.updateSession(named.id, { name: "  Renamed ", archived: true });
assert.equal(renamed.name, "Renamed");
assert.ok(renamed.archivedAt);
list = await client.listSessions();
assert.equal(list.find((s) => s.id === named.id).name, "Renamed");
await assert.rejects(client.updateSession(named.id, { name: " " }), /1–120 characters/);
await assert.rejects(client.updateSession("0000", { archived: false }), /no such session/);
// The name's length is the worker's rule, in the description, not the schema:
// 61 emoji are 61 characters but 122 UTF-16 units; a padded name is trimmed first.
const emoji = { name: "🙂".repeat(61) };
conforms(spec.components.schemas.SessionPatch, emoji, "61 emoji");
await assert.rejects(client.updateSession(named.id, emoji), /1–120 characters/);
assert.equal((await client.updateSession(named.id, { name: `${" ".repeat(120)}a` })).name, "a");
assert.deepEqual(await client.getDiff(repo.id), await workspace.diff());
assert.deepEqual(await client.listPorts(repo.id), { ports: [5173, 8080] });
for (const route of ["diff", "ports", "terminal"]) {
  const response = await call(new Request(`${base}/api/session/0000/${route}`, { headers: { Upgrade: "websocket" } }));
  assert.equal(response.status, 404, route);
}

// The sockets: the upgrade only.
const upgrade = { headers: { Upgrade: "websocket" } };
assert.equal((await call(new Request(`${base}/api/session/${repo.id}/terminal`, upgrade))).status, 101);
for (const path of [`/api/session/${repo.id}/ws`, `/api/session/${repo.id}/terminal`, "/api/directory/ws"]) {
  assert.equal((await call(new Request(`${base}${path}`))).status, 426, path);
}

// Providers and sign-in.
let providers = await client.listProviders();
assert.deepEqual(providers.map((p) => [p.id, p.oauth?.label ?? null, p.connected]), [["anthropic", "Sign in", null], ["openai", null, null]]);
let auth = await client.setApiKey("openai", "sk-test");
assert.deepEqual(auth, { providers: ["openai"], agent: { model: { provider: "openai", modelId: "gpt-6-astra" }, thinkingLevel: "high" } });
const ends = [];
const step = await client.startLogin("anthropic", (end) => ends.push(end));
assert.deepEqual(step, { url: "https://example.test/authorize" });
auth = await client.finishLogin("http://localhost:53692/callback?code=abc&state=s");
assert.deepEqual(auth.providers.sort(), ["anthropic", "openai"]);
providers = await client.listProviders();
assert.deepEqual(providers.map((p) => p.connected), ["oauth", "api_key"]);
auth = await client.logout("anthropic");
assert.deepEqual(auth.providers, ["openai"]);
// The same sign-in finished from the dev server's loopback redirect, then failed ones.
await client.startLogin("anthropic", (end) => ends.push(end));
let page = await client.authCallback("http://localhost:53692/callback?code=xyz");
assert.equal(page.status, 200);
assert.match(page.body, /Signed in\. .*close\(\)/s);
page = await client.authCallback("http://localhost:53692/callback?error=denied");
assert.equal(page.status, 400);
assert.match(page.body, /no sign-in is waiting/);
await client.startLogin("anthropic", (end) => ends.push(end));
await assert.rejects(client.finishLogin("http://localhost:53692/callback?error=denied"), /the redirect has no code/);
assert.deepEqual(await client.startLogin("openai", (end) => ends.push(end)), { error: "openai has no sign-in" });
await Promise.all(streams);
assert.deepEqual(ends, [{ done: true }, { done: true }, { error: "the redirect has no code" }]);

// Sandbox tokens, and the GitHub lookups that use the first.
assert.deepEqual(await client.listSandboxTokens(), { keys: [] });
await assert.rejects(client.listRepos(), /Add a GitHub token/);
assert.deepEqual(await client.setSandboxTokens({ GH_TOKEN: "ghp_test", LINEAR_API_KEY: "lin_test" }), { keys: ["GH_TOKEN", "LINEAR_API_KEY"] });
assert.deepEqual(await client.setSandboxTokens({ LINEAR_API_KEY: "" }), { keys: ["GH_TOKEN"] });
await assert.rejects(client.setSandboxTokens({ OPENAI_API_KEY: "sk" }), /unknown token OPENAI_API_KEY/);
assert.deepEqual(await client.listSandboxTokens(), { keys: ["GH_TOKEN"] });
assert.deepEqual((await client.listRepos()).map((r) => r.fullName), ["neiltron/celld-test"]);
assert.deepEqual(await client.listBranches("neiltron/celld-test"), { defaultBranch: "main", branches: ["main", "dev"] });
await assert.rejects(client.listBranches("not a repo"), /owner\/name/);
await assert.rejects(client.listBranches("neiltron/missing"), /GitHub 404: Not Found/);

// Artifacts, saved the way the agent's tool saves them.
const plan = await artifacts.save({ session: repo.id, title: "Plan", kind: "markdown", content: "# Plan\nRoute from the spec" });
await artifacts.save({ id: plan.id, session: repo.id, title: "Plan", kind: "markdown", content: "# Plan\nRoute from the contract" });
await artifacts.save({ session: named.id, title: "Chart", kind: "code", language: "js", content: "plot()" });
assert.deepEqual((await client.listArtifacts({ session: repo.id })).map((a) => [a.title, a.version]), [["Plan", 2]]);
assert.equal((await client.listArtifacts({})).length, 2);
const [hit, ...rest] = await client.listArtifacts({ q: "contract" });
assert.equal(rest.length, 0);
assert.match(hit.snippet, /\[contract\]/);
assert.equal((await client.getArtifact(plan.id)).content, "# Plan\nRoute from the contract");
assert.equal((await client.getArtifact(plan.id, 1)).content, "# Plan\nRoute from the spec");
await assert.rejects(client.getArtifact(plan.id, 9), /no such artifact/);
await assert.rejects(client.getArtifact("nope"), /no such artifact/);

// Error responses.
const post = (body) => new Request(`${base}/api/sessions`, { method: "POST", body });
assert.equal((await call(post("not json"))).status, 500);
const broken = { ...env, DIRECTORY: { getByName: () => ({ list() { throw new Error("directory offline"); } }) } };
assert.equal((await call(new Request(`${base}/api/sessions`), { environment: broken })).status, 500);
await assert.rejects(apiClient(base, (r) => call(r, { environment: broken })).listSessions(), /directory offline/);

const operations = Object.values(spec.paths).flatMap((item) => Object.values(item).map((op) => op.operationId));
assert.deepEqual([...called].sort(), operations.sort(), "every operation in openapi.json is driven above");

// Drift: the worker serves exactly the methods the spec lists on every path
// in it (call() fails on listed but unrouted).
const sample = { id: repo.id, provider: "anthropic", artifactId: plan.id };
for (const path of Object.keys(spec.paths)) {
  const url = `${base}${path.replace(/\{(\w+)\}/g, (_, name) => sample[name])}`;
  for (const method of METHODS) {
    // fetch forbids TRACE, so no client can send one and no worker receives one.
    if (method === "TRACE") {
      assert.ok(!spec.paths[path].trace, `TRACE ${path} is in openapi.json but fetch can't send it`);
      continue;
    }
    const body = method === "GET" || method === "HEAD" ? undefined : "{}";
    const response = await call(new Request(url, { method, body }), { probe: true });
    const listed = !!spec.paths[path][method.toLowerCase()];
    assert.ok(listed || await unrouted(response), `${method} ${path} is served by the worker but missing from openapi.json`);
  }
}
await Promise.all(streams);

// The client's reading of the Preview port rule is the schema's.
const previewPort = ajv.compile(spec.components.schemas.PreviewPort);
for (let port = 0; port <= 70000; port++) assert.equal(validPreviewPort(port), previewPort(port), `port ${port}`);
console.log("contract.check ok");
