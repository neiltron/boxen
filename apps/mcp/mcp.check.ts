// Self-check for the MCP server, through the MCP protocol: node mcp.check.ts
// An SDK client talks to createServer() over the SDK's in-memory transport
// pair. A fake fetch stands in for the REST API and a scripted socket for the
// Session cell (as in apps/cli/cli.check.ts), so no backend runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_URL, type Transport } from "@pi-durable-sessions/client";
import { createServer, type Deps } from "./server.ts";

const meta = { id: "s1", name: "untitled", cwd: "/workspace", createdAt: 1 };
const artifact = { id: "a1", session: "s1", title: "Plan", kind: "markdown", language: null, version: 2, createdAt: 1, updatedAt: 2 };
const requests: { method: string; url: string; body: unknown }[] = [];
const fakeFetch = async (req: Request) => {
  requests.push({ method: req.method, url: req.url, body: req.method === "POST" ? await req.json() : undefined });
  const { pathname } = new URL(req.url);
  if (pathname === "/api/sessions") return Response.json(req.method === "GET" ? [{ ...meta, status: "idle" }] : meta);
  if (pathname === "/api/artifacts") return Response.json([artifact]);
  if (pathname === "/api/artifacts/a1") return Response.json({ ...artifact, content: "# Plan\n\nStep one." });
  return Response.json({ error: "No such artifact" }, { status: 404 });
};

// A Session cell that answers on the next tick. The prompt text picks the
// outcome: "refuse", "fail", "drop", "long" (text, a tool call, more text),
// "hold" (starts a tool call and waits for an abort), "deaf" (holds and never
// settles the abort), else a streamed "Hello".
const commands: string[] = [];
let closed = 0;
const cell = (open = true): Transport => (_url, on) => {
  const frame = (m: object) => queueMicrotask(() => on.message(JSON.stringify(m)));
  const events = (...evs: object[]) => frame({ type: "events", events: evs });
  if (open) queueMicrotask(() => on.open());
  let held: ((status: string, rest?: object) => object) | null = null;
  let deaf = false;
  return {
    send(data) {
      const cmd = JSON.parse(data);
      commands.push(cmd.type);
      if (cmd.type === "abort" && held && !deaf) events(held("unanswered", { reason: "aborted" }));
      const rec = (status: string, rest = {}) => ({ type: "submission", record: { id: 7, requestId: cmd.requestId, status, ...rest } });
      if (cmd.type === "sub") {
        frame({ type: "meta", meta });
        events({ type: "snapshot", entries: [], tools: [] });
        frame({ type: "ready" });
      }
      if (cmd.type !== "prompt") return;
      if (cmd.message === "refuse") return frame({ type: "error", error: "No model is configured", requestId: cmd.requestId });
      deaf = cmd.message === "deaf";
      if (cmd.message === "long" || cmd.message === "hold" || deaf) {
        const call = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } };
        events(rec("placed"), { type: "message_start", message: { role: "assistant", content: [] } },
          { type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Looking." }] },
          { type: "message_update", changes: [{ type: "toolcall_start", contentIndex: 1, block: call }] },
          { type: "message_end", entry: { id: 2, model: [{ role: "assistant", content: [{ type: "text", text: "Looking." }, call] }] } },
          { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: call.arguments });
        if (cmd.message !== "long") { held = rec; return; }
        return events({ type: "tool_execution_end", toolCallId: "c1", entry: { model: [{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "a b" }] }] } },
          { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Found two files." }] } },
          { type: "message_end", entry: { id: 3, model: [{ role: "assistant", content: [{ type: "text", text: "Found two files." }] }] } },
          rec("done", { answer: 3 }));
      }
      events(rec("placed"), { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Hel" }] });
      if (cmd.message === "drop") return queueMicrotask(() => queueMicrotask(() => on.close()));
      if (cmd.message === "fail") return events(rec("unanswered", { reason: "model_error", detail: "429 Too Many Requests" }));
      events({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] },
        { type: "message_end", entry: { id: 2, model: [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }] } },
        rec("done", { answer: 2 }));
    },
    close() { closed++; },
  };
};

async function connect(deps: Partial<Deps> = {}, url = DEFAULT_URL) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(url, { transport: cell(), fetch: fakeFetch, ...deps }).connect(serverSide);
  const client = new Client({ name: "mcp.check", version: "0" });
  await client.connect(clientSide);
  return client;
}
const mcp = await connect();
const call = async (name: string, args: Record<string, unknown> = {}, client = mcp) => (await client.callTool({ name, arguments: args })) as CallToolResult;
const text = (r: CallToolResult, i = 0) => (r.content[i] as { text: string }).text;

// The tools, each described for an agent that has never seen the system.
{
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["list_sessions", "create_session", "run_turn", "list_artifacts", "search_artifacts", "read_artifact"]);
  for (const t of tools) assert.match(t.description ?? "", /^A Session is one coding agent/, t.name);
  const run = tools.find((t) => t.name === "run_turn")!;
  assert.deepEqual(run.inputSchema.required, ["session", "prompt"]);
  assert.match(run.description!, /minutes/);
}

// REST tools: the API's answer as JSON, its failure as the tool's error.
{
  requests.length = 0;
  assert.deepEqual(JSON.parse(text(await call("list_sessions"))), [{ ...meta, status: "idle" }]);
  assert.deepEqual(JSON.parse(text(await call("create_session", { name: "n", repo: "https://x/r.git" }))), meta);
  assert.deepEqual(JSON.parse(text(await call("list_artifacts", { session: "s1" }))), [artifact]);
  await call("list_artifacts");
  await call("search_artifacts", { query: "step one" });
  const read = await call("read_artifact", { artifact: "a1", version: 2 });
  assert.deepEqual([JSON.parse(text(read)), text(read, 1)], [artifact, "# Plan\n\nStep one."]);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    `GET ${DEFAULT_URL}/api/sessions`,
    `POST ${DEFAULT_URL}/api/sessions`,
    `GET ${DEFAULT_URL}/api/artifacts?session=s1`,
    `GET ${DEFAULT_URL}/api/artifacts`,
    `GET ${DEFAULT_URL}/api/artifacts?q=step%20one`,
    `GET ${DEFAULT_URL}/api/artifacts/a1?v=2`,
  ]);
  assert.deepEqual(requests[1].body, { name: "n", repo: "https://x/r.git" });

  const missing = await call("read_artifact", { artifact: "nope" });
  assert.deepEqual([missing.isError, text(missing)], [true, "No such artifact"]);
  const down = await connect({ fetch: async () => { throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8093") }); } });
  const refused = await call("list_sessions", {}, down);
  assert.deepEqual([refused.isError, text(refused)], [true, "fetch failed (connect ECONNREFUSED 127.0.0.1:8093)"]);
  assert.equal((await call("search_artifacts", { query: "" })).isError, true, "the schema refuses an empty query");
}

// run_turn: the answer's text when done; every other outcome an error that says what to do.
{
  assert.deepEqual(await call("run_turn", { session: "s1", prompt: "hi" }), { content: [{ type: "text", text: "Hello" }] });
  const refused = await call("run_turn", { session: "s1", prompt: "refuse" });
  assert.deepEqual([refused.isError, text(refused)], [true, "The turn failed: No model is configured"]);
  assert.equal(text(await call("run_turn", { session: "s1", prompt: "fail" })), "The turn failed: 429 Too Many Requests");
  const dropped = await call("run_turn", { session: "s1", prompt: "drop" });
  assert.equal(dropped.isError, true);
  assert.match(text(dropped), /^Outcome unknown: .* may still be running .*list_sessions/);

  const unreachable = await connect({ transport: cell(false), connectMs: 10 });
  const r = await call("run_turn", { session: "s1", prompt: "hi" }, unreachable);
  assert.equal(r.isError, true);
  assert.match(text(r), /no connection to ws:\/\/127\.0\.0\.1:8093\/api\/session\/s1\/ws in 0\.01 s\. Nothing was sent/);
}

// A long turn reports its steps as progress notifications on the caller's token.
{
  const progress: { progress: number; message?: string }[] = [];
  const r = await mcp.callTool({ name: "run_turn", arguments: { session: "s1", prompt: "long" } }, undefined, { onprogress: (p) => progress.push(p) });
  assert.equal(text(r as CallToolResult), "Found two files.");
  assert.deepEqual(progress, [
    { progress: 1, message: "connected to the Session; prompt sent" },
    { progress: 2, message: "wrote: Looking." },
    { progress: 3, message: 'tool bash {"command":"ls"}' },
    { progress: 4, message: "wrote: Found two files." },
  ]);
}

// Cancelling the request aborts the turn in the Session and closes the socket.
{
  commands.length = 0;
  closed = 0;
  const stop = new AbortController();
  const running = mcp.callTool({ name: "run_turn", arguments: { session: "s1", prompt: "hold" } }, undefined, {
    signal: stop.signal,
    onprogress: (p) => { if (p.message?.startsWith("tool")) stop.abort(); },
  });
  await assert.rejects(running, /AbortError|aborted/i);
  for (let i = 0; i < 10 && !closed; i++) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(commands, ["sub", "prompt", "abort"]);
  assert.equal(closed, 1, "the Session's socket is closed once the turn settles");
}

// A cell that never settles the abort: run_turn stops waiting after abortMs
// and closes the socket, instead of holding the call and the socket forever.
{
  commands.length = 0;
  closed = 0;
  const deafServer = await connect({ abortMs: 20 });
  const stop = new AbortController();
  const running = deafServer.callTool({ name: "run_turn", arguments: { session: "s1", prompt: "deaf" } }, undefined, {
    signal: stop.signal,
    onprogress: (p) => { if (p.message?.startsWith("tool")) stop.abort(); },
  });
  await assert.rejects(running, /AbortError|aborted/i);
  for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual([commands, closed], [["sub", "prompt", "abort"], 1]);
}

// A request with id 0 (valid JSON-RPC) can be cancelled too. The SDK's
// Client never uses 0 after initialize, so this speaks raw JSON-RPC.
{
  commands.length = 0;
  closed = 0;
  const [raw, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(DEFAULT_URL, { transport: cell(), fetch: fakeFetch }).connect(serverSide);
  const seen: unknown[] = [];
  raw.onmessage = (m) => seen.push(m);
  await raw.start();
  await raw.send({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
  await raw.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await raw.send({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "run_turn", arguments: { session: "s1", prompt: "hold" } } });
  for (let i = 0; i < 100 && !commands.includes("prompt"); i++) await new Promise((r) => setTimeout(r, 1));
  await raw.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 0, reason: "changed my mind" } });
  for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual([commands, closed], [["sub", "prompt", "abort"], 1], "cancelling request 0 aborts its turn");
  assert.equal(seen.filter((m) => (m as { id?: unknown }).id === 0).length, 0, "and sends no response to it");
  await raw.close();
}

// The real stdio entrypoint, as a child process against a Session cell on a
// real WebSocket: when stdin ends (a client shutting down) or a signal
// arrives, the running turn is aborted and the process exits by itself.
{
  // Just enough of a WebSocket server for the cell's small text frames.
  const backend: string[] = [];
  const server = http.createServer((_, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (m: object) => {
      const body = Buffer.from(JSON.stringify(m));
      socket.write(Buffer.concat([Buffer.from(body.length < 126 ? [0x81, body.length] : [0x81, 126, body.length >> 8, body.length & 255]), body]));
    };
    socket.on("close", () => backend.push("closed"));
    socket.on("error", () => {});
    let buf = Buffer.alloc(0);
    let prompt = "";
    socket.on("data", (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      for (;;) {
        const short = buf.length >= 2 ? buf[1] & 127 : 0;
        const at = short === 126 ? 4 : 2;
        const len = short === 126 ? buf.readUInt16BE(2) : short;
        if (buf.length < 2 || buf.length < at + 4 + len) return;
        const mask = buf.subarray(at, at + 4);
        const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len).map((b, i) => b ^ mask[i % 4]));
        const opcode = buf[0] & 15;
        buf = buf.subarray(at + 4 + len);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const cmd = JSON.parse(payload.toString());
        backend.push(cmd.type);
        if (cmd.type === "sub") { send({ type: "meta", meta }); send({ type: "events", events: [{ type: "snapshot", entries: [], tools: [] }] }); send({ type: "ready" }); }
        if (cmd.type === "prompt") prompt = cmd.requestId;
        if (cmd.type === "prompt") send({ type: "events", events: [{ type: "submission", record: { id: 7, requestId: cmd.requestId, status: "placed" } }] });
        if (cmd.type === "abort") send({ type: "events", events: [{ type: "submission", record: { id: 7, requestId: prompt, status: "unanswered", reason: "aborted" } }] });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  for (const shutdown of ["stdin end", "SIGTERM", "SIGINT"] as const) {
    backend.length = 0;
    const child = spawn(process.execPath, [new URL("server.ts", import.meta.url).pathname], {
      env: { ...process.env, PDS_URL: `http://127.0.0.1:${port}` }, stdio: ["pipe", "pipe", "ignore"],
    });
    const exited = once(child, "exit");
    const rpc = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    rpc({ id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "stdio", version: "0" } } });
    rpc({ method: "notifications/initialized" });
    rpc({ id: 2, method: "tools/call", params: { name: "run_turn", arguments: { session: "s1", prompt: "hold" } } });
    for (let i = 0; i < 500 && !backend.includes("prompt"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(backend, ["sub", "prompt"], `${shutdown}: the turn is running`);
    if (shutdown === "stdin end") child.stdin.end(); else child.kill(shutdown);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [code, signal] = await exited;
    clearTimeout(timer);
    for (let i = 0; i < 100 && !backend.includes("closed"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual({ code, signal, backend }, { code: 0, signal: null, backend: ["sub", "prompt", "abort", "closed"] }, `${shutdown}: aborted, exited by itself`);
  }
  server.close();
}

assert.deepEqual(process.getActiveResourcesInfo().filter((r) => r === "Timeout"), [], "no timers left running");
console.log("mcp.check: ok");
