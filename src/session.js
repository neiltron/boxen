// Session — one cell per pi session, and the agent itself. A pi-durable
// Harness lives in the cell over the cell's own SQLite: transcript, streaming
// partials, tool output, and the queue are all committed there, so a restart
// picks up mid-turn. Tools run in this session's Sandbox container. Every
// browser gets its own watchEvents() stream: a snapshot, then live deltas.
import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
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
    registry.install(artifactExtension(this.env.ARTIFACTS.getByName("main"), meta.id));
    const harness = await Harness.open(
      await SqliteStorage.open(new CellSqlite(this.state.storage)),
      {
        models,
        registry,
        env: async ({ cwd }) => sandboxEnv(sandbox, `sandbox:${meta.id}`, cwd ?? meta.cwd, await directory.secrets()),
      },
      ctx,
    );
    const defaults = await directory.defaultAgent();
    const root = await harness.root(ctx, { agent: { ...defaults, cwd: meta.cwd } });
    // A session made before any provider was connected starts without a model.
    if (!(await root.agent(ctx)).model && defaults.model) await root.configure(defaults, ctx);
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

  // The working tree against HEAD, untracked files included. A throwaway
  // index marks them intent-to-add, so the agent's own index is untouched.
  async diff() {
    const meta = await this.meta();
    const { workspace } = await this.open();
    await workspace;
    const env = sandboxEnv(getSandbox(this.env.Sandbox, meta.id), `sandbox:${meta.id}`, meta.cwd);
    let out = "";
    const script = [
      `cd ${shellQuote(meta.cwd)} || exit 3`,
      `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 4`,
      `idx=$(mktemp); cp "$(git rev-parse --git-dir)/index" "$idx" 2>/dev/null`,
      `GIT_INDEX_FILE=$idx git add -A -N . 2>/dev/null && GIT_INDEX_FILE=$idx git diff HEAD --no-color --no-ext-diff; s=$?; rm -f "$idx"; exit $s`,
    ].join("\n");
    const r = await env.exec(script, { onOutput: (t) => { out += t; } }, ctx);
    if (!r.ok) throw r.error;
    if (r.value.exitCode === 4 || r.value.exitCode === 3) return { repo: false, patch: "" };
    if (r.value.exitCode !== 0) throw new Error(out.trim().split("\n").at(-1) || `git diff exited ${r.value.exitCode}`);
    return { repo: true, patch: out };
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
        const { root, workspace, models } = await this.open();
        await workspace;
        await root.submit({ type: "input", content: cmd.message, whenBusy: "steer" }, ctx);
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
