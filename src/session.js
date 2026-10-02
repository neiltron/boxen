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
import { sandboxEnv } from "./sandbox-env.js";

const WORKSPACE = "/workspace";

const Prompt = defineExtension({
  name: "prompt",
  sections: [
    section("preamble", () =>
      "You are pi, a coding agent working in a Linux sandbox. Use the tools to inspect and change files and run commands. Be concise.",
      { tag: false }),
    section("cwd", (input) => input.env?.cwd),
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
        env: ({ cwd }) => sandboxEnv(sandbox, `sandbox:${meta.id}`, cwd ?? WORKSPACE),
      },
      ctx,
    );
    const root = await harness.root(ctx, { agent: { ...(await directory.defaultAgent()), cwd: WORKSPACE } });
    const status = await watchEvents(harness, root.id, ctx);
    status.start(async (events) => this.track(meta.id, events));
    return { harness, root, models };
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
        const { root } = await this.open();
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
