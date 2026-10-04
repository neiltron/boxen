// pi-durable-sessions — shared pi agent sessions on celld, with the agent
// inside the cell. pi-sessions ran `pi --mode rpc` on the host behind a
// pi-host bridge; here a pi-durable Harness runs in each Session cell, and
// tools run in a per-session Sandbox container that celld supervises.
//
//   browsers ⇄ WS ⇄ Session cell (Harness + SQLite) ⇄ Sandbox container (bash, files)
//                     │ model calls straight from the cell
//                     └ register/touch/credentials → Directory cell ⇄ WS ⇄ sidebar
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { validateMetadataPatch } from "./session-metadata.js";
import { previewTarget, validPreviewPort, sessionWorkspace, PREVIEW_PORT } from "./workspace.js";
import spec from "@pi-durable-sessions/client/openapi.json" with { type: "json" };

// pi-ai loads OAuth flows through a dynamic import the bundle can't follow;
// this registers them statically, the way pi's Bun binary does.
registerBunOAuthFlows();
// pi-ai decodes JWT payloads with atob, which here rejects unpadded base64url.
const strictAtob = globalThis.atob;
globalThis.atob = (s) => strictAtob(String(s).replace(/-/g, "+").replace(/_/g, "/")
  .padEnd(Math.ceil(String(s).length / 4) * 4, "="));

export { Sandbox } from "./sandbox.js";
export { Artifacts } from "./artifacts.js";
export { Directory } from "./directory.js";
export { Session } from "./session.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

// One handler per operation in openapi.json, named by its operationId, with
// the path's {params}. The url is the request's, parsed.
const handlers = {
  listSessions: async (request, env) => json(await env.DIRECTORY.getByName("main").list()),
  async createSession(request, env) {
    const body = await request.json();
    const repo = body.repo?.trim() || undefined;
    const meta = {
      id: crypto.randomUUID(),
      name: body.name || repo?.split("/").pop()?.replace(/\.git$/, "") || "untitled",
      cwd: repo ? `/workspace/${repo.split("/").pop().replace(/\.git$/, "")}` : "/workspace",
      repo,
      branch: body.branch?.trim() || undefined,
      titled: !!body.name, // an explicit name stands; otherwise the first message titles it
      createdAt: Date.now(),
    };
    await env.SESSION.getByName(meta.id).init(meta);
    return json(meta);
  },
  async updateSession(request, env, { id }) {
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
    const patch = validateMetadataPatch(body);
    const session = env.SESSION.getByName(id);
    if (!await session.meta()) return json({ error: "no such session" }, 404);
    return json(await session.updateMetadata(patch));
  },
  // The Sandbox routes, for existing sessions only: an unknown id would
  // otherwise create a cell and boot a container.
  getDiff: (request, env, { id }) => existing(env, id, async ({ session }) => json(await session.diff())),
  listPorts: (request, env, { id }) => existing(env, id, async ({ meta }) => json({ ports: await sessionWorkspace(env, meta).ports() })),
  terminalSocket: (request, env, { id }) => upgrade(request, () => existing(env, id, ({ session }) => session.fetch(request))),
  sessionSocket: (request, env, { id }) => upgrade(request, () => env.SESSION.getByName(id).fetch(request)),
  directorySocket: (request, env) => env.DIRECTORY.getByName("main").fetch(request),

  listProviders: async (request, env) => json(await env.DIRECTORY.getByName("main").providers()),
  setApiKey: async (request, env, { provider }) =>
    json(await env.DIRECTORY.getByName("main").setApiKey(provider, (await request.json()).key)),
  // Model sign-in, run by the Directory cell: start → open url → paste redirect.
  startLogin: (request, env) => env.DIRECTORY.getByName("main").fetch(request),
  finishLogin: async (request, env) => json(await env.DIRECTORY.getByName("main").loginFinish((await request.json()).redirectUrl)),
  logout: async (request, env) => json(await env.DIRECTORY.getByName("main").logout((await request.json()).provider)),
  async authCallback(request, env, params, url) {
    const { ok, message } = await env.DIRECTORY.getByName("main").loginCallback(url.searchParams.get("u") ?? "");
    const html = `<!doctype html><meta charset="utf-8"><title>pi sessions</title>
<body style="font:15px system-ui;display:grid;place-items:center;height:90vh;color-scheme:light dark">
<p>${message.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</p>${ok ? "<script>setTimeout(() => close(), 1500)</script>" : ""}`;
    return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
  },

  // Artifacts: ?session= lists one session's, ?q= searches all of them.
  async listArtifacts(request, env, params, url) {
    const artifacts = env.ARTIFACTS.getByName("main");
    const q = url.searchParams.get("q");
    return json(q ? await artifacts.search(q) : await artifacts.list(url.searchParams.get("session")));
  },
  async getArtifact(request, env, { artifactId }, url) {
    const row = await env.ARTIFACTS.getByName("main").get(artifactId, Number(url.searchParams.get("v")) || undefined);
    return row ? json(row) : json({ error: "no such artifact" }, 404);
  },

  listRepos: async (request, env) => json(await env.DIRECTORY.getByName("main").githubRepos()),
  async listBranches(request, env, params, url) {
    const repo = url.searchParams.get("repo") ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
    return json(await env.DIRECTORY.getByName("main").githubBranches(repo));
  },
  // Names only, never values.
  listSandboxTokens: async (request, env) => json({ keys: Object.keys(await env.DIRECTORY.getByName("main").secrets()) }),
  setSandboxTokens: async (request, env) => json({ keys: await env.DIRECTORY.getByName("main").setSecrets(await request.json()) }),
};

async function existing(env, id, then) {
  const session = env.SESSION.getByName(id);
  const meta = await session.meta();
  return meta ? then({ session, meta }) : json({ error: "no such session" }, 404);
}

function upgrade(request, then) {
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return then();
  return new Response("websocket upgrade required", { status: 426 });
}

// openapi.json is the route table: a request reaches a handler only through
// an operation there, each {param} matching its parameter's pattern, so the
// worker serves no API route the spec lacks. contract.check.mjs drives every
// operation the other way. Route nothing in fetch() below past this table:
// that is the one route the check can't see.
const param = (p) => (p.$ref ? spec.components.parameters[p.$ref.split("/").pop()] : p);
const routes = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({
  method: method.toUpperCase(),
  handler: handlers[op.operationId],
  pattern: new RegExp(`^${path.replace(/\{(\w+)\}/g, (_, name) =>
    `(?<${name}>${op.parameters.map(param).find((p) => p.in === "path" && p.name === name).schema.pattern.slice(1, -1)})`)}$`),
})));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // Host routing must precede API routing and even OPTIONS: those paths
      // and preflights belong to the app, not this worker.
      const preview = previewTarget(request.headers.get("host") ?? "");
      if (preview) {
        if (!validPreviewPort(preview.port)) {
          return new Response(`Preview ports must be ${PREVIEW_PORT.minimum}–${PREVIEW_PORT.maximum}, excluding ${PREVIEW_PORT.not.const}.`, { status: 400 });
        }
        // Only existing sessions: any UUID-shaped host would otherwise boot a sandbox.
        // Proxied here, not in the cell, so the streaming response is this request's.
        const meta = await env.SESSION.getByName(preview.id).meta();
        if (!meta) return new Response("no such session", { status: 404 });
        return sessionWorkspace(env, meta).preview(request, preview.port);
      }
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      for (const { method, pattern, handler } of routes) {
        const match = request.method === method && url.pathname.match(pattern);
        if (match && handler) return await handler(request, env, match.groups ?? {}, url);
      }
      // Installed builds serve the UI from celld itself. Keep API misses as
      // JSON, and route preview hosts above before looking up static assets.
      if (env.ASSETS && !url.pathname.startsWith("/api/") && url.pathname !== "/api" &&
          (request.method === "GET" || request.method === "HEAD")) {
        return env.ASSETS.fetch(request);
      }
      return json({ error: "unknown route" }, 404);
    } catch (e) {
      return json({ error: e.message }, e.status ?? 500);
    }
  },
};
