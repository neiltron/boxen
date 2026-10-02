// Session — one cell per pi session, and the agent itself. A pi-durable
// Harness lives in the cell over the cell's own SQLite: transcript, streaming
// partials, tool output, and the queue are all committed there, so a restart
// picks up mid-turn. Tools run in this session's Sandbox container. Every
// browser gets its own watchEvents() stream: a snapshot, then live deltas.
import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, defineExtension, Harness, section, watchEvents } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { CellSqlite } from "./cell-sqlite.js";
import { directoryCredentials } from "./credentials.js";
import { sandboxEnv, shellQuote } from "./sandbox-env.js";

const WORKSPACE = "/workspace";

const Prompt = defineExtension({
  name: "prompt",
  sections: [
    section("preamble", () =>
      "You are pi, a coding agent working in a Linux sandbox (Ubuntu, with git, gh, node, bun, python3, rg). " +
      "Use the tools to inspect and change files and run commands. GH_TOKEN is set when the user configured one, " +
      "so git push and gh work against GitHub. Be concise.",
      { tag: false }),
    section("cwd", (input) => input.env?.cwd),
    // The repo's own instructions, re-read each request (unchanged text keeps the cache warm).
    section("project_instructions", async ({ env }, context) => {
      if (!env) return undefined;
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const file = await env.readTextFile(`${env.cwd}/${name}`, context);
        if (file.ok) return file.value;
      }
      return undefined;
    }),
  ],
});

export class Session extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.streams = new Map(); // ws → AgentEventStream
    this.status = "idle";
    this.lastTouch = 0;
  }

  async init(meta) {
    await this.state.storage.put("meta", meta);
    await this.env.DIRECTORY.getByName("main").register(meta);
    await this.open();
    return meta;
  }

  async meta() {
    return (await this.state.storage.get("meta")) ?? null;
  }

  // Opening the Harness also resumes whatever the last process left running.
  open() {
    this.opening ??= this.openHarness().catch((e) => { this.opening = null; throw e; });
    return this.opening;
  }

  async openHarness() {
    const meta = await this.meta();
    const directory = this.env.DIRECTORY.getByName("main");
    const sandbox = getSandbox(this.env.Sandbox, meta.id);
    const models = builtinModels({ credentials: directoryCredentials(directory) });
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(Prompt);
    const harness = await Harness.open(
      await SqliteStorage.open(new CellSqlite(this.state.storage)),
      {
        models,
        registry,
        env: async ({ cwd }) => sandboxEnv(sandbox, `sandbox:${meta.id}`, cwd ?? meta.cwd, await directory.secrets()),
      },
      ctx,
    );
    const root = await harness.root(ctx, { agent: { ...(await directory.defaultAgent()), cwd: meta.cwd } });
    const status = await watchEvents(harness, root.id, ctx);
    status.start(async (events) => this.track(meta.id, events));
    const opened = { harness, root, models };
    opened.workspace = this.ensureWorkspace(meta, sandbox, root, directory).catch((e) =>
      this.note(root, `workspace setup failed: ${e.message}`, "error"));
    return opened;
  }

  // Clones the session's repo when the container doesn't have it: at creation,
  // and again after the container lost its disk.
  async ensureWorkspace(meta, sandbox, root, directory) {
    if (!meta.repo) return;
    const env = sandboxEnv(sandbox, `sandbox:${meta.id}`, WORKSPACE, await directory.secrets());
    if ((await env.exists(`${meta.cwd}/.git`, ctx)).value) return;
    await this.note(root, `cloning ${meta.repo}${meta.branch ? ` (${meta.branch})` : ""}…`);
    let output = "";
    const branch = meta.branch ? `--branch ${shellQuote(meta.branch)} ` : "";
    const result = await env.exec(`git clone ${branch}${shellQuote(meta.repo)} ${shellQuote(meta.cwd)}`,
      { onOutput: (text) => { output += text; } }, ctx);
    if (!result.ok || result.value.exitCode !== 0) {
      throw new Error(output.trim().split("\n").at(-1) || (result.ok ? `exit ${result.value.exitCode}` : result.error.message));
    }
    await this.note(root, `cloned into ${meta.cwd}`);
  }

  // A durable line in the transcript that the model never sees.
  note(root, text, level = "info") {
    return root.submit({ type: "write", entry: { kind: "app.note", data: { text, level } } }, ctx);
  }

  // Browser WebSocket. Nothing is sent during the upgrade (Safari drops
  // frames that early) — the client sends "sub" when its socket is open.
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[0]);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  async subscribe(ws) {
    const meta = await this.meta();
    if (!meta) return;
    const { harness, root } = await this.open();
    const stream = await watchEvents(harness, root.id, ctx);
    this.streams.set(ws, stream);
    const send = (msg) => { try { ws.send(JSON.stringify(msg)); } catch {} };
    send({ type: "meta", meta });
    send({ type: "events", events: [stream.snapshot] });
    send({ type: "ready" });
    stream.start(async (events) => send({ type: "events", events }));
  }

  unsubscribe(ws) {
    this.streams.get(ws)?.stop();
    this.streams.delete(ws);
  }

  async webSocketClose(ws) { this.unsubscribe(ws); }
  async webSocketError(ws) { this.unsubscribe(ws); }

  // Commands from any connected browser. A prompt while the agent works
  // steers it; the user's message shows up in every tab once it is placed.
  async webSocketMessage(ws, raw) {
    let cmd;
    try { cmd = JSON.parse(raw); } catch { return; }
    try {
      if (cmd.type === "sub") return await this.subscribe(ws);
      if (cmd.type === "prompt" || cmd.type === "steer") {
        const { root, workspace } = await this.open();
        await workspace;
        await root.submit({ type: "input", content: cmd.message, whenBusy: "steer" }, ctx);
      } else if (cmd.type === "models") {
        const { models } = await this.open();
        const list = (await models.getAvailable()).map((m) => ({
          provider: m.provider, id: m.id, name: m.name, thinkingLevels: getSupportedThinkingLevels(m),
        }));
        ws.send(JSON.stringify({ type: "models", models: list }));
      } else if (cmd.type === "configure") {
        // Applies from the next model request; a running turn keeps its model.
        const { root } = await this.open();
        await root.configure({ model: cmd.model, thinkingLevel: cmd.thinkingLevel }, ctx);
      } else if (cmd.type === "abort") {
        const { root } = await this.open();
        await root.abort(ctx);
      } else if (cmd.type === "rename") {
        const meta = await this.meta();
        const updated = { ...meta, name: cmd.name };
        await this.state.storage.put("meta", updated);
        await this.env.DIRECTORY.getByName("main").rename({ id: meta.id, name: cmd.name });
        for (const sock of this.streams.keys()) {
          try { sock.send(JSON.stringify({ type: "meta", meta: updated })); } catch {}
        }
      }
    } catch (e) {
      try { ws.send(JSON.stringify({ type: "error", error: e.message })); } catch {}
    }
  }

  async track(id, events) {
    let status = null;
    for (const ev of events) {
      if (ev.type === "run_start") status = "running";
      else if (ev.type === "run_end") status = "idle";
    }
    const now = Date.now();
    if (status && status !== this.status) {
      this.status = status;
      await this.env.DIRECTORY.getByName("main").touch({ id, status });
      this.lastTouch = now;
    } else if (now - this.lastTouch > 3000) {
      await this.env.DIRECTORY.getByName("main").touch({ id });
      this.lastTouch = now;
    }
  }
}
