// pi-durable-sessions — shared pi agent sessions on celld, with the agent
// inside the cell. pi-sessions ran `pi --mode rpc` on the host behind a
// pi-host bridge; here a pi-durable Harness runs in each Session cell, and
// tools run in a per-session Sandbox container that celld supervises.
//
//   browsers ⇄ WS ⇄ Session cell (Harness + SQLite) ⇄ Sandbox container (bash, files)
//                     │ model calls straight from the cell
//                     └ register/touch/credentials → Directory cell ⇄ WS ⇄ sidebar
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

// pi-ai loads OAuth flows through a dynamic import the bundle can't follow;
// this registers them statically, the way pi's Bun binary does.
registerBunOAuthFlows();
// pi-ai decodes JWT payloads with atob, which here rejects unpadded base64url.
const strictAtob = globalThis.atob;
globalThis.atob = (s) => strictAtob(String(s).replace(/-/g, "+").replace(/_/g, "/")
  .padEnd(Math.ceil(String(s).length / 4) * 4, "="));

export { Sandbox } from "@cloudflare/sandbox";
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
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      if (url.pathname === "/api/sessions" && request.method === "GET") {
        return json(await env.DIRECTORY.getByName("main").list());
      }
      if (url.pathname === "/api/sessions" && request.method === "POST") {
        const body = await request.json();
        const meta = {
          id: crypto.randomUUID(),
          name: body.name || "untitled",
          cwd: "/workspace",
          createdAt: Date.now(),
        };
        await env.SESSION.getByName(meta.id).init(meta);
        return json(meta);
      }
      // Login + default agent, seeded by start.sh from ~/.pi/agent.
      if (url.pathname === "/api/auth" && request.method === "POST") {
        const body = await request.json();
        return json(await env.DIRECTORY.getByName("main").seed({ ...body, force: url.searchParams.has("force") }));
      }
      if (url.pathname === "/api/directory/ws") {
        return env.DIRECTORY.getByName("main").fetch(request);
      }
      const m = url.pathname.match(/^\/api\/session\/([0-9a-f-]+)\/ws$/);
      if (m) return env.SESSION.getByName(m[1]).fetch(request);
      return json({ error: "unknown route" }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
