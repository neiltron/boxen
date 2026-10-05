// Self-check for pds, through main(): node cli.check.ts
// A fake fetch stands in for the REST API and a scripted socket for the
// Session cell (as in packages/client/session.check.ts), so no backend runs.
import assert from "node:assert/strict";
import { DEFAULT_URL, type Transport } from "@pi-durable-sessions/client";
import { main, type Deps } from "./pds.ts";

const meta = { id: "s1", name: "untitled", cwd: "/workspace", createdAt: 1 };
const requests: { method: string; url: string; body: unknown }[] = [];
const fakeFetch = async (req: Request) => {
  requests.push({ method: req.method, url: req.url, body: req.method === "POST" ? await req.json() : undefined });
  if (req.url.endsWith("/api/sessions") && req.method === "GET") return Response.json([{ ...meta, status: "idle" }, { ...meta, id: "s2", name: "old", archivedAt: 5 }]);
  if (req.url.endsWith("/api/sessions")) return Response.json(meta);
  return Response.json({ error: "no such route" }, { status: 500 });
};

// A Session cell that answers on the next tick. The prompt text picks the
// outcome: "refuse", "fail", "drop", else a streamed "Hello" answer.
const sockets: string[] = [];
const cell = (open = true): Transport => (url, on) => {
  sockets.push(url);
  const frame = (m: object) => queueMicrotask(() => on.message(JSON.stringify(m)));
  const events = (...evs: object[]) => frame({ type: "events", events: evs });
  if (open) queueMicrotask(() => on.open());
  return {
    send(data) {
      const cmd = JSON.parse(data);
      const rec = (status: string, rest = {}) => ({ type: "submission", record: { id: 7, requestId: cmd.requestId, status, ...rest } });
      if (cmd.type === "sub") {
        frame({ type: "meta", meta });
        events({ type: "snapshot", entries: [], tools: [] });
        frame({ type: "ready" });
      }
      if (cmd.type !== "prompt") return;
      if (cmd.message === "refuse") return frame({ type: "error", error: "No model is configured", requestId: cmd.requestId });
      events(rec("placed"), { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Hel" }] });
      if (cmd.message === "drop") return queueMicrotask(() => queueMicrotask(() => on.close()));
      if (cmd.message === "fail") return events(rec("unanswered", { reason: "model_error", detail: "429 Too Many Requests" }));
      events({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] },
        { type: "message_end", entry: { id: 2, model: [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }] } },
        rec("done", { answer: 2 }));
    },
    close() {},
  };
};

async function pds(argv: string[], deps: Partial<Deps> = {}) {
  let out = "", err = "";
  const code = await main(argv, {
    env: {}, transport: cell(), fetch: fakeFetch,
    out: (t) => { out += t; }, err: (t) => { err += t; }, ...deps,
  });
  return { code, out, err };
}

// Help and usage: help on stdout, usage errors on stderr with exit 2.
{
  const help = await pds(["help"]);
  assert.equal(help.code, 0);
  for (const c of ["list", "create", "prompt", "Sessions:", "--json", "--url"]) assert.ok(help.out.includes(c), c);
  assert.deepEqual(await pds(["list", "--help"]), { code: 0, out: help.out, err: "" });
  assert.equal((await pds([])).code, 2);
  assert.match((await pds(["frobnicate"])).err, /unknown command: frobnicate/);
  assert.equal((await pds(["list", "--name", "x"])).code, 2, "options belong to their command");
  assert.match((await pds(["prompt", "s1"])).err, /needs a session id and the text/);
  // Commands that take no arguments refuse them, before any request.
  requests.length = 0;
  assert.match((await pds(["create", "my-session"])).err, /Unexpected argument 'my-session'/);
  assert.equal((await pds(["list", "extra"])).code, 2);
  assert.equal(requests.length, 0);
}

// The system's URL must be http(s), from the flag or the environment.
{
  const bad = [
    await pds(["prompt", "s1", "hi", "--url", "ftp://example.test"]),
    await pds(["list", "--url", "not a url"]),
    await pds(["list"], { env: { PDS_URL: "ws://x" } }),
  ];
  for (const r of bad) {
    assert.equal(r.code, 2);
    assert.match(r.err, /must be http\(s\)/);
  }
}

// The target: --url, else $PDS_URL, else the default.
{
  requests.length = 0;
  await pds(["list"]);
  await pds(["list"], { env: { PDS_URL: "http://env:1" } });
  await pds(["list", "--url", "http://flag:2/prefix/"], { env: { PDS_URL: "http://env:1" } });
  assert.deepEqual(requests.map((r) => r.url), [`${DEFAULT_URL}/api/sessions`, "http://env:1/api/sessions", "http://flag:2/prefix/api/sessions"]);
}

// list and create, as text and as JSON.
{
  assert.deepEqual(await pds(["list"]), { code: 0, out: "s1\tidle\tuntitled\ns2\tarchived\told\n", err: "" });
  const json = await pds(["list", "--json"]);
  assert.deepEqual(JSON.parse(json.out), [{ ...meta, status: "idle" }, { ...meta, id: "s2", name: "old", archivedAt: 5 }]);

  requests.length = 0;
  assert.deepEqual(await pds(["create", "--name", "n", "--repo", "https://x/r.git"]), { code: 0, out: "s1\n", err: "" });
  assert.deepEqual(requests[0], { method: "POST", url: `${DEFAULT_URL}/api/sessions`, body: { name: "n", repo: "https://x/r.git" } });
  assert.deepEqual(JSON.parse((await pds(["create", "--json"])).out), meta);
}

// API failures: the worker's error on stderr, exit 1.
{
  const broken = await pds(["list"], { fetch: async () => Response.json({ error: "Directory is down" }, { status: 500 }) });
  assert.deepEqual(broken, { code: 1, out: "", err: `pds: ${DEFAULT_URL}: Directory is down\n` });
}

// prompt: streams to stdout, exits 0 only when done; JSON prints just the result.
{
  sockets.length = 0;
  assert.deepEqual(await pds(["prompt", "s1", "say", "hi"], { env: { PDS_URL: "https://box.ts.net" } }), { code: 0, out: "Hello\n", err: "" });
  assert.deepEqual(sockets, ["wss://box.ts.net/api/session/s1/ws"]);
  assert.deepEqual(await pds(["prompt", "s1", "hi", "--json"]), { code: 0, out: '{"status":"done","text":"Hello"}\n', err: "" });

  assert.deepEqual(await pds(["prompt", "s1", "refuse"]), { code: 1, out: "", err: "error: No model is configured\n" });
  assert.deepEqual(JSON.parse((await pds(["prompt", "s1", "refuse", "--json"])).out), { status: "error", error: "No model is configured" });
  assert.deepEqual(await pds(["prompt", "s1", "fail"]), { code: 1, out: "Hel\n", err: "error: 429 Too Many Requests\n" });
  const dropped = await pds(["prompt", "s1", "drop", "--json"]);
  assert.deepEqual([dropped.code, JSON.parse(dropped.out)], [1, { status: "disconnected" }]);

  // Ctrl-C before the prompt went out sends nothing.
  assert.deepEqual(await pds(["prompt", "s1", "hi", "--json"], { signal: AbortSignal.abort() }), { code: 1, out: '{"status":"aborted"}\n', err: "" });

  // No join in time: an error naming the socket, not a hang.
  const unreachable = await pds(["prompt", "s1", "hi"], { transport: cell(false), connectMs: 10 });
  assert.deepEqual(unreachable, { code: 1, out: "", err: `error: no connection to ws://127.0.0.1:8093/api/session/s1/ws in 0.01 s\n` });
}

// A transport that throws fails the command, and prompt leaves no timer
// behind (its join deadline, the client's ping) to keep the process alive.
{
  const broken = await pds(["prompt", "s1", "hi"], { transport: () => { throw new Error("no socket for you"); }, connectMs: 60_000 });
  assert.deepEqual(broken, { code: 1, out: "", err: `pds: ${DEFAULT_URL}: no socket for you\n` });
  assert.deepEqual(process.getActiveResourcesInfo().filter((r) => r === "Timeout"), [], "no timers left running");
}

console.log("cli.check: ok");
