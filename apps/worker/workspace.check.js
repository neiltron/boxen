// Run with node workspace.check.js; no celld or container required.
// Drives src/workspace.js through its interface with an in-memory sandbox.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The sandbox boundary is stubbed; runtime library types stay real.
const stubs = {
  "@cloudflare/sandbox": "export function getSandbox() { throw new Error('use the fake sandbox'); }",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in stubs) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { workspace, previewTarget, validPreviewPort } = await import("./src/workspace.js");

const unquote = (s) => s.slice(1, -1).replaceAll(`'\\''`, "'"); // inverse of shellQuote
const procNet = (ports) => ports.map((p, i) => `${i}: 00000000:${p.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A`).join("\n");

// The container behind a fake @cloudflare/sandbox object: a disk of paths, the
// last checkpoint, terminal shells, listening ports. `run(script)` can answer a
// command first; otherwise git clone makes the repo, the diff script answers
// from the disk, and /proc/net/tcp lists `listening`.
function fakeSandbox({ run, backup = null, listening = [], proc, patch = "", duplicate = { code: "SESSION_ALREADY_EXISTS" }, serve } = {}) {
  const upgrade = { status: 101, webSocket: {} }; // Node's Response can't be 101
  const sb = {
    disk: new Set(["/workspace"]), prepared: false, backup, shells: new Map(), execs: [], attached: [], upgrade,
    loseDisk() { sb.disk = new Set(["/workspace"]); sb.prepared = false; sb.shells.clear(); },
    clones: () => sb.execs.filter((e) => e.script.startsWith("git clone")).length,

    async prepare() {
      if (sb.prepared) return "ready";
      sb.prepared = true;
      if (!sb.backup) return "ready";
      sb.disk = new Set(sb.backup);
      return "restored";
    },
    async checkpoint() { sb.backup = new Set(sb.disk); return { id: "backup" }; },
    async exists(path) { return { exists: sb.disk.has(path) }; },
    async exec(command, options = {}) {
      const script = command.startsWith("bash -c ") ? unquote(command.slice(8)) : command;
      sb.execs.push({ script, options });
      const r = (await run?.(script)) ?? container(script);
      if (r.stdout) options.onOutput?.("stdout", r.stdout);
      if (r.stderr) options.onOutput?.("stderr", r.stderr);
      return { success: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    async execStream(command, options) {
      const encoder = new TextEncoder();
      const chunks = [];
      const result = await sb.exec(command, { ...options, onOutput: (type, data) => chunks.push({ type, data }) });
      chunks.push({ type: "complete", exitCode: result.exitCode });
      return new ReadableStream({ start(controller) {
        for (const event of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      } });
    },
    async createSession({ id, cwd }) {
      if (sb.shells.has(id)) throw duplicate;
      sb.shells.set(id, { cwd });
    },
    async getSession(id) {
      return { terminal(request, options) { sb.attached.push({ id, request, options }); return upgrade; } };
    },
    async containerFetch(request, port) { return serve(request, port, "http"); },
    async wsConnect(request, port) { return serve(request, port, "ws"); },
  };
  function container(script) {
    const clone = script.match(/^git clone .*'([^']*)'$/);
    if (clone) {
      sb.disk.add(clone[1]).add(`${clone[1]}/.git`);
      return { exitCode: 0, stderr: `Cloning into '${clone[1]}'...\n` };
    }
    const cd = script.match(/^cd '([^']*)' \|\| exit 3\n/);
    if (cd) return !sb.disk.has(cd[1]) ? { exitCode: 3 } : !sb.disk.has(`${cd[1]}/.git`) ? { exitCode: 4 } : { exitCode: 0, stdout: patch };
    if (script.startsWith("cat /proc/net/tcp;")) return { exitCode: 0, stdout: proc ?? procNet(listening) };
    throw new Error(`the fake container can't run: ${script}`);
  }
  return sb;
}

const repo = { id: "abc-123", cwd: "/workspace/app", repo: "https://github.com/o/app.git", branch: "dev" };
const secrets = async () => ({ GH_TOKEN: "tok" });
function open(meta = repo, options = {}) {
  const sandbox = fakeSandbox(options);
  const notes = [];
  return { sandbox, notes, ws: workspace(sandbox, meta, { secrets, onProgress: async (...note) => { notes.push(note); } }) };
}

// Clone only when .git is missing; concurrent callers share one clone.
{
  const { sandbox, notes, ws } = open(repo, { patch: "diff --git a/x b/x\n" });
  const [, env, diff] = await Promise.all([ws.prepare(), ws.env(), ws.diff()]);
  assert.equal(sandbox.clones(), 1);
  const clone = sandbox.execs.find((e) => e.script.startsWith("git clone"));
  assert.equal(clone.script, "git clone --branch 'dev' 'https://github.com/o/app.git' '/workspace/app'");
  assert.equal(clone.options.cwd, "/workspace");
  assert.match(clone.options.env.GIT_CONFIG_KEY_0, /x-access-token:tok@github\.com/, "the clone gets the secrets");
  assert.deepEqual(notes, [["cloning https://github.com/o/app.git (dev)…"], ["cloned into /workspace/app"]]);
  assert.deepEqual(diff, { repo: true, patch: "diff --git a/x b/x\n" });
  // The agent's ExecutionEnv: the session's id and cwd, with secrets.
  assert.equal(env.id, "sandbox:abc-123");
  assert.equal(env.cwd, "/workspace/app");
  assert.equal((await ws.env("/tmp")).cwd, "/tmp");
  await ws.prepare();
  await ws.diff();
  assert.equal(sandbox.clones(), 1, "an existing .git is left alone");
  assert.equal(notes.length, 2);
}

// A session without a repo never clones.
{
  const { sandbox, notes, ws } = open({ id: "no-repo", cwd: "/workspace" });
  await ws.prepare();
  assert.deepEqual(await ws.diff(), { repo: false, patch: "" }, "exit 4: not a repo");
  assert.equal(sandbox.clones(), 0);
  assert.deepEqual(notes, []);
}

// After a lost disk, the terminal and Changes both get the repo back; with a
// checkpoint, it is restored rather than cloned again.
{
  const { sandbox, notes, ws } = open();
  await ws.terminal(new Request("https://example.test/t"));
  sandbox.loseDisk();
  await ws.terminal(new Request("https://example.test/t"));
  assert.equal(sandbox.clones(), 2, "the terminal re-clones");
  assert.deepEqual(sandbox.attached.map((a) => a.id), ["terminal-abc-123", "terminal-abc-123"]);
  sandbox.loseDisk();
  assert.equal((await ws.diff()).repo, true, "Changes re-clones too");
  assert.equal(sandbox.clones(), 3);
  await ws.checkpoint();
  sandbox.loseDisk();
  notes.length = 0;
  assert.equal((await ws.diff()).repo, true);
  assert.equal(sandbox.clones(), 3, "restored, not cloned");
  assert.deepEqual(notes, [["restored the workspace from its last checkpoint"]]);
}

// A failed clone says why, in the transcript and to the caller; the next caller retries.
{
  let fail = true;
  const { sandbox, notes, ws } = open(repo, {
    run: (script) => fail && script.startsWith("git clone")
      ? { exitCode: 128, stderr: "Cloning into '/workspace/app'...\nfatal: repository 'https://github.com/o/app.git/' not found\n" }
      : undefined,
  });
  await assert.rejects(ws.prepare(), { message: "fatal: repository 'https://github.com/o/app.git/' not found" });
  assert.deepEqual(notes.at(-1), ["workspace setup failed: fatal: repository 'https://github.com/o/app.git/' not found", "error"]);
  await assert.rejects(ws.terminal(new Request("https://example.test/t")), /not found/);
  assert.equal(sandbox.attached.length, 0);
  fail = false;
  await ws.prepare();
  assert.equal(sandbox.clones(), 3);
  assert.deepEqual(notes.at(-1), ["cloned into /workspace/app"]);
}
{
  const { ws } = open(repo, { run: (script) => script.startsWith("git clone") ? { exitCode: 1 } : undefined });
  await assert.rejects(ws.prepare(), { message: "exit 1" }, "no output: the exit code");
}

// Changes: exit 3 (no such directory) and 4 (not a repo) are "not a repo";
// other failures surface git's last line.
{
  assert.deepEqual(await open({ id: "gone", cwd: "/workspace/gone" }).ws.diff(), { repo: false, patch: "" }, "exit 3");
  const answer = (r) => open(repo, { run: (script) => script.startsWith("cd ") ? r : undefined }).ws;
  assert.deepEqual(await answer({ exitCode: 4 }).diff(), { repo: false, patch: "" });
  assert.deepEqual(await answer({ exitCode: 0, stdout: "" }).diff(), { repo: true, patch: "" }, "a clean tree");
  await assert.rejects(answer({ exitCode: 128, stderr: "warning: x\nfatal: bad revision 'HEAD'\n" }).diff(), { message: "fatal: bad revision 'HEAD'" });
  await assert.rejects(answer({ exitCode: 2 }).diff(), { message: "git diff exited 2" });
  const { sandbox, ws } = open(repo);
  await ws.prepare();
  sandbox.exec = async () => { throw new Error("container unavailable"); };
  await assert.rejects(ws.diff(), { message: "container unavailable" });
}

// The terminal reuses its shell, and hands back the exact upgrade for the
// browser's own request.
for (const duplicate of [{ code: "SESSION_ALREADY_EXISTS" }, { name: "SessionAlreadyExistsError" }]) {
  const { sandbox, ws } = open(repo, { duplicate });
  const request = new Request("https://example.test/api/session/abc-123/terminal", { headers: { Upgrade: "websocket" } });
  assert.equal(await ws.terminal(request), sandbox.upgrade);
  assert.equal(await ws.terminal(request), sandbox.upgrade, "an existing shell is reused");
  assert.deepEqual([...sandbox.shells], [["terminal-abc-123", { cwd: "/workspace/app" }]]);
  for (const attached of sandbox.attached) {
    assert.equal(attached.request, request);
    assert.deepEqual(attached.options, { cols: 80, rows: 24, shell: "/bin/bash" });
  }
}
{
  const { ws } = open(repo, { duplicate: new Error("container unavailable") });
  await ws.terminal(new Request("https://example.test/t"));
  await assert.rejects(ws.terminal(new Request("https://example.test/t")), /container unavailable/, "don't swallow setup errors");
}

// Preview hosts and ports.
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

// The listening-port check is cached per session, so each case gets its own id.
const preview = (name, options) => open({ id: name, cwd: "/workspace" }, options).ws;

// A quiet port answers at once instead of waiting on the SDK's 90s port check.
const quiet = await preview("quiet", {
  listening: [8000], serve() { throw new Error("must not be called for a quiet port"); },
}).preview(new Request(`http://${host}/`), 5173);
assert.equal(quiet.status, 502);
assert.match(await quiet.text(), /Nothing is listening on port 5173/);

// Host routing leaves app paths, headers, bodies, statuses and redirects alone.
for (const method of ["GET", "POST", "OPTIONS"]) {
  const request = new Request(`http://${host}/api/app?q=hello%20world`, {
    method, headers: { host, "x-app": "kept" }, ...(method === "POST" ? { body: "payload" } : {}),
  });
  const response = new Response("upstream", { status: 307, headers: { location: "/login" } });
  const result = await preview(`http-${method}`, {
    listening: [5173],
    async serve(forwarded, port, kind) {
      assert.equal(kind, "http");
      assert.equal(port, 5173);
      assert.equal(forwarded.url, request.url);
      assert.equal(forwarded.method, method);
      assert.equal(forwarded.headers.get("host"), host);
      assert.equal(forwarded.headers.get("x-app"), "kept");
      assert.equal(forwarded.redirect, "manual");
      if (method === "POST") assert.equal(await forwarded.text(), "payload");
      return response;
    },
  }).preview(request, 5173);
  assert.equal(result, response);
}
const upgrade = new Request(`http://${host}/hmr?token=abc`, {
  headers: { host, Upgrade: "WebSocket", "Sec-WebSocket-Protocol": "vite-hmr", "x-sandbox-preview-proxy": "1", "x-sandbox-name": "other" },
});
const upgraded = { status: 101, webSocket: {} };
assert.equal(await preview("ws", {
  listening: [5173],
  async serve(request, port, kind) {
    assert.equal(kind, "ws");
    assert.equal(request.url, upgrade.url);
    assert.equal(request.headers.get("connection"), "Upgrade");
    assert.equal(request.headers.get("sec-websocket-protocol"), "vite-hmr");
    assert.equal(request.headers.get("host"), host);
    assert.equal(request.headers.has("x-sandbox-preview-proxy"), false);
    assert.equal(request.headers.has("x-sandbox-name"), false);
    assert.equal(port, 5173);
    return upgraded;
  },
}).preview(upgrade, 5173), upgraded, "no wrapping");
const failed = await preview("failing", {
  listening: [5173], serve() { throw new Error("connection refused"); },
}).preview(new Request(`http://${host}/`), 5173);
assert.equal(failed.status, 502);
assert.match(await failed.text(), /connection refused/);

const ports = open({ id: "ports", cwd: "/workspace" }, { proc: `  sl  local_address rem_address st
      0: 00000000:1435 00000000:0000 0A
      1: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A
      2: 00000000:0BB8 00000000:0000 0A
      3: 00000000:0050 00000000:0000 0A
      4: 00000000:1F90 00000000:0000 01
      5: 00000000:0400 00000000:0000 0A
      6: 00000000:FFFF 00000000:0000 0A\n` });
assert.deepEqual(await ports.ws.ports(), [1024, 5173, 65535]);
assert.equal(ports.sandbox.execs[0].options.timeout, 5000);
await assert.rejects(preview("no-proc", { run: () => ({ exitCode: 1, stderr: "unavailable" }) }).ports(), /unavailable/);
console.log("workspace checks passed");
