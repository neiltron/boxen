// Session — one cell per pi session, and the agent itself. A pi-durable
// Harness lives in the cell over the cell's own SQLite: transcript, streaming
// partials, tool output, and the queue are all committed there, so a restart
// picks up mid-turn. Tools run in this session's Sandbox container. Every
// browser gets its own watchEvents() stream: a snapshot, then live deltas.
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, defineExtension, defineTool, Harness, section, watchEvents } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { ARTIFACT_KINDS } from "./artifacts.js";
import { CellSqlite } from "./cell-sqlite.js";
import { directoryCredentials } from "./credentials.js";
import { sessionWorkspace } from "./workspace.js";

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

// Shows something in the panel beside the chat. Saves are versioned in the
// Artifacts cell; the UI opens the artifact from this call's details.
function artifactExtension(artifacts, session) {
  const tool = defineTool({
    name: "artifact",
    description:
      "Show the user a document or visual in the panel beside the chat: a plan, an explainer, a report, " +
      "a diagram, a chart, a small interactive demo. Kinds: markdown; html (a complete page; inline CSS/JS, " +
      "CDN scripts allowed, runs sandboxed); svg; mermaid (diagram source); code (set language). " +
      "Pass the id of an artifact you made earlier to revise it instead of creating another. " +
      "Prefer this over long chat replies for anything the user will want to look at or come back to.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Existing artifact id, to update it" })),
      title: Type.String(),
      kind: Type.Union(ARTIFACT_KINDS.map((k) => Type.Literal(k))),
      language: Type.Optional(Type.String({ description: "For kind code" })),
      content: Type.String(),
    }),
    execute: async (args) => {
      const saved = await artifacts.save({ ...args, session });
      return {
        content: [{ type: "text", text: `Artifact ${saved.id} v${saved.version} is showing in the panel.` }],
        details: { artifactId: saved.id, version: saved.version, title: args.title, kind: args.kind },
      };
    },
  });
  return defineExtension({ name: "artifacts", tools: [tool] });
}

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
    this.workspace().then((w) => w.prepare()).catch(() => {}); // clone now rather than on the first tool call
    return meta;
  }

  async meta() {
    return (await this.state.storage.get("meta")) ?? null;
  }

  // The live Harness. Every open also resumes the run the last one left
  // unfinished: Harness.open() alone leaves the scheduler paused.
  open() {
    this.opening ??= (this.closing ?? Promise.resolve())
      .then(() => this.openHarness())
      .catch((e) => { this.opening = null; throw e; });
    return this.opening;
  }

  async openHarness() {
    const meta = await this.meta();
    const directory = this.env.DIRECTORY.getByName("main");
    const models = builtinModels({ credentials: directoryCredentials(directory) });
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(Prompt);
    registry.install(artifactExtension(this.env.ARTIFACTS.getByName("main"), meta.id));
    const harness = await Harness.open(
      await SqliteStorage.open(new CellSqlite(this.state.storage)),
      {
        models,
        registry,
        // Built per tool call, so a container that lost its disk since the
        // last call gets its files back before the tool runs.
        env: async ({ cwd }) => (await this.workspace()).env(cwd),
        onReport: (e) => this.report(e),
      },
      ctx,
    );
    try {
      const defaults = await directory.defaultAgent();
      const root = await harness.root(ctx, { agent: { ...defaults, cwd: meta.cwd } });
      // A session made before any provider was connected starts without a model.
      if (!(await root.agent(ctx)).model && defaults.model) await root.configure(defaults, ctx);
      const status = await watchEvents(harness, root.id, ctx);
      status.start(async (events) => this.track(meta.id, events));
      harness.resume();
      return { harness, root, models, status };
    } catch (e) {
      await harness.close(ctx).catch(() => {});
      throw e;
    }
  }

  // A commit that fails after storage admission poisons the Harness for
  // good; pi-durable only reports it. Replace it with a fresh one over the
  // same storage. The poisoned one can't commit again, so a slow close
  // can't overlap writes with its successor.
  report(e) {
    console.error(`session ${this.state.id}: harness report`, describe(e));
    if (poisoned(e)) this.reopen();
  }

  reopen() {
    if (this.closing) return this.closing;
    const old = this.opening;
    this.opening = null;
    this.closing = (async () => {
      const opened = await old?.catch(() => null);
      if (!opened) return;
      opened.status.stop();
      for (const stream of this.streams.values()) stream.stop();
      this.streams.clear();
      await Promise.race([opened.harness.close(ctx).catch(() => {}), sleep(30_000)]);
      // Browsers reconnect and subscribe to the new Harness.
      for (const ws of this.state.getWebSockets()) { try { ws.close(4000, "session reopened"); } catch {} }
    })().finally(() => { this.closing = null; });
    // The alarm opens the new Harness, which resumes the interrupted run.
    return this.closing.then(() => this.state.storage.setAlarm(Date.now()));
  }

  // Set while a run goes, so a cell that restarts mid-run (node restart,
  // self-fence after sleep) reopens and resumes it with no browser attached.
  // The handler holds the run's I/O to a live event until the run ends,
  // then checkpoints the workspace. celld redelivers an alarm that runs
  // long (about every 15s), so redeliveries join the one already watching.
  alarm() {
    this.watching ??= this.watchRun().finally(() => { this.watching = null; });
    return this.watching;
  }

  async watchRun() {
    const meta = await this.meta();
    if (!meta) return;
    const { harness } = await this.open();
    try {
      const idle = await Promise.race([harness.waitForIdle(ctx).then(() => true), sleep(10 * 60_000).then(() => false)]);
      if (!idle) return void await this.state.storage.setAlarm(Date.now());
    } catch (e) {
      if (poisoned(e)) return void await this.reopen();
      throw e;
    }
    await this.setStatus(meta.id, "idle");
    await (await this.workspace()).checkpoint();
  }

  // Everything this Session does to its Sandbox goes through one workspace
  // (src/workspace.js), so tool calls, Changes, and the terminal share one
  // restore or clone. It reads meta's id, cwd and repo, which never change.
  // The worker sends only existing sessions here.
  workspace() {
    this.workspacing ??= this.meta().then((meta) => {
      if (!meta) { this.workspacing = null; throw new Error("no such session"); }
      return sessionWorkspace(this.env, meta, (text, level) => this.note(text, level));
    });
    return this.workspacing;
  }

  async diff() {
    return (await this.workspace()).diff();
  }

  // A durable line in the transcript that the model never sees.
  async note(text, level = "info") {
    if (this.closing) return; // the closing Harness waits on whoever is noting
    const { root } = await this.open();
    return root.submit({ type: "write", entry: { kind: "app.note", data: { text, level } } }, ctx);
  }

  // Browser WebSocket upgrades, already checked by the worker. Nothing is sent
  // during the upgrade (Safari drops frames that early) — the client sends
  // "sub" when its socket is open.
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/terminal")) return (await this.workspace()).terminal(request);
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
        const { root, models } = await this.open();
        // A retry with the same requestId finds the first submission.
        await root.submit({ type: "input", content: cmd.message, whenBusy: "steer", requestId: cmd.requestId }, ctx);
        // Awaited here: a cell's I/O must belong to a live request or event.
        if (!(await this.meta()).titled) await this.autoTitle(models, root, cmd.message);
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
        await this.rename(cmd.name);
      }
    } catch (e) {
      console.error(`session ${this.state.id}: ${cmd.type} failed`, describe(e));
      if (poisoned(e)) this.reopen();
      try { ws.send(JSON.stringify({ type: "error", error: e.message })); } catch {}
    }
  }

  // A manual rename also counts as the title, so autoTitle leaves it alone.
  async rename(name) {
    const meta = await this.meta();
    const updated = { ...meta, name, titled: true };
    await this.state.storage.put("meta", updated);
    await this.env.DIRECTORY.getByName("main").rename({ id: meta.id, name });
    for (const sock of this.streams.keys()) {
      try { sock.send(JSON.stringify({ type: "meta", meta: updated })); } catch {}
    }
  }

  // Names the session from its first message, once, with the session's own
  // model at its lowest reasoning level. Failures keep the starting name.
  async autoTitle(models, root, text) {
    await this.state.storage.put("meta", { ...(await this.meta()), titled: true });
    const ref = (await root.agent(ctx)).model;
    const model = ref && models.getModel(ref.provider, ref.modelId);
    if (!model) return;
    const reply = await models.completeSimple(model, {
      systemPrompt: "Write a title of 2 to 6 words for a coding session that starts with the user's message. " +
        "Reply with the title only: no quotes, no trailing punctuation.",
      messages: [{ role: "user", content: text.slice(0, 2000), timestamp: Date.now() }],
    }, { reasoning: getSupportedThinkingLevels(model)[0] });
    const title = reply.content.filter((c) => c.type === "text").map((c) => c.text).join(" ")
      .replace(/["'`*]/g, "").replace(/[.!?:]+$/, "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (reply.stopReason !== "error" && title) await this.rename(title);
  }

  async track(id, events) {
    let status = null;
    for (const ev of events) {
      if (ev.type === "run_start") status = "running";
      else if (ev.type === "run_end") status = "idle";
    }
    if (status === "running") await this.state.storage.setAlarm(Date.now());
    await this.setStatus(id, status);
  }

  async setStatus(id, status) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const causes = (e) => (e ? [e, ...causes(e.cause)] : []);

// ponytail: matches pi-durable's message; use a typed check if it exports one.
const poisoned = (e) => causes(e).some((c) => /Session is poisoned/.test(c?.message));

// The whole cause chain, so a log shows the failure that poisoned the Harness.
const describe = (e) => causes(e).map((c) => c?.stack ?? String(c)).join("\ncaused by: ");
