// pi-durable-sessions — shared pi agent sessions on celld, with the agent
// inside the cell. pi-sessions ran `pi --mode rpc` on the host behind a
// pi-host bridge; here a pi-durable Harness runs in each Session cell, and
// tools run in a per-session Sandbox container that celld supervises.
//
//   browsers ⇄ WS ⇄ Session cell (Harness + SQLite) ⇄ Sandbox container (bash, files)
//                     │ model calls straight from the cell
//                     └ register/touch/credentials → Directory cell ⇄ WS ⇄ sidebar
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { getSandbox } from "@cloudflare/sandbox";
import { previewTarget, validPreviewPort, proxyPreview, listeningPorts } from "./preview.js";

// pi-ai loads OAuth flows through a dynamic import the bundle can't follow;
// this registers them statically, the way pi's Bun binary does.
registerBunOAuthFlows();
// pi-ai decodes JWT payloads with atob, which here rejects unpadded base64url.
const strictAtob = globalThis.atob;
globalThis.atob = (s) => strictAtob(String(s).replace(/-/g, "+").replace(/_/g, "/")
  .padEnd(Math.ceil(String(s).length / 4) * 4, "="));

export { Sandbox } from "@cloudflare/sandbox";
export { Artifacts } from "./artifacts.js";
export { Directory } from "./directory.js";
export { Session } from "./session.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // Host routing must precede API routing and even OPTIONS: those paths
      // and preflights belong to the app, not this worker.
      const preview = previewTarget(request.headers.get("host") ?? "");
      if (preview) {
        if (!validPreviewPort(preview.port)) return new Response("Preview ports must be 1024–65535, excluding 3000.", { status: 400 });
        return proxyPreview(request, getSandbox(env.Sandbox, preview.id), preview.port);
      }
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (url.pathname === "/api/sessions" && request.method === "GET") {
        return json(await env.DIRECTORY.getByName("main").list());
      }
      if (url.pathname === "/api/sessions" && request.method === "POST") {
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
      }
      if (url.pathname === "/api/auth/callback") {
        const { ok, message } = await env.DIRECTORY.getByName("main").loginCallback(url.searchParams.get("u") ?? "");
        const html = `<!doctype html><meta charset="utf-8"><title>pi sessions</title>
<body style="font:15px system-ui;display:grid;place-items:center;height:90vh;color-scheme:light dark">
<p>${message.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</p>${ok ? "<script>setTimeout(() => close(), 1500)</script>" : ""}`;
        return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/api/providers") return json(await env.DIRECTORY.getByName("main").providers());
      const key = url.pathname.match(/^\/api\/providers\/([\w.-]+)\/key$/);
      if (key && request.method === "POST") {
        return json(await env.DIRECTORY.getByName("main").setApiKey(key[1], (await request.json()).key));
      }
      // Model sign-in, run by the Directory cell: start → open url → paste redirect.
      const auth = url.pathname.match(/^\/api\/auth\/(login|finish|logout)$/);
      if (auth?.[1] === "login") return env.DIRECTORY.getByName("main").fetch(request);
      if (auth && request.method === "POST") {
        const body = await request.json();
        const directory = env.DIRECTORY.getByName("main");
        if (auth[1] === "finish") return json(await directory.loginFinish(body.redirectUrl));
        return json(await directory.logout(body.provider));
      }
      // Artifacts: ?session= lists one session's, ?q= searches all of them.
      if (url.pathname === "/api/artifacts") {
        const artifacts = env.ARTIFACTS.getByName("main");
        const q = url.searchParams.get("q");
        return json(q ? await artifacts.search(q) : await artifacts.list(url.searchParams.get("session")));
      }
      const art = url.pathname.match(/^\/api\/artifacts\/([\w-]+)$/);
      if (art) {
        const row = await env.ARTIFACTS.getByName("main").get(art[1], Number(url.searchParams.get("v")) || undefined);
        return row ? json(row) : json({ error: "no such artifact" }, 404);
      }
      if (url.pathname === "/api/github/repos") return json(await env.DIRECTORY.getByName("main").githubRepos());
      if (url.pathname === "/api/github/branches") {
        const repo = url.searchParams.get("repo") ?? "";
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "repo must be owner/name" }, 400);
        return json(await env.DIRECTORY.getByName("main").githubBranches(repo));
      }
      if (url.pathname === "/api/secrets") {
        const directory = env.DIRECTORY.getByName("main");
        if (request.method === "POST") return json({ keys: await directory.setSecrets(await request.json()) });
        return json({ keys: Object.keys(await directory.secrets()) }); // names only, never values
      }
      if (url.pathname === "/api/directory/ws") {
        return env.DIRECTORY.getByName("main").fetch(request);
      }
      const m = url.pathname.match(/^\/api\/session\/([0-9a-f-]+)\/(ws|diff|ports)$/);
      if (m?.[2] === "ports" && request.method === "GET") {
        if (!await env.SESSION.getByName(m[1]).meta()) return json({ error: "no such session" }, 404);
        return json({ ports: await listeningPorts(getSandbox(env.Sandbox, m[1])) });
      }
      if (m?.[2] === "ws") return env.SESSION.getByName(m[1]).fetch(request);
      if (m?.[2] === "diff") return json(await env.SESSION.getByName(m[1]).diff());
      return json({ error: "unknown route" }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
