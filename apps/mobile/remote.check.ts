// The phone's Session tools (src/remote.ts) against Sessions that behave
// like the real ones: each is cell.ts over a Harness with a faux model,
// behind a fake REST API. Run: node remote.check.ts
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { sessionClient, type Transport } from "@boxen/client";
import { openAgent, serve, type Agent } from "./src/cell.ts";
import { githubExtension } from "./src/github.ts";
import { remoteExtension } from "./src/remote.ts";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

// One agent per Session id, made on first use.
const sessions = new Map<string, { agent: Agent; connect: ReturnType<typeof serve> }>();
async function cellFor(id: string) {
  if (!sessions.has(id)) {
    const agent = await openAgent(new MemoryStorage(), models);
    await agent.root.configure({ model: { provider: model.provider, modelId: model.id } }, ctx);
    sessions.set(id, { agent, connect: serve(Promise.resolve(agent)) });
  }
  return sessions.get(id)!;
}
const transport: Transport = (url, on) => {
  const id = url.match(/session\/([^/]+)\/ws/)![1];
  let conn: { message(raw: string): void; close(): void } | null = null;
  const ready = cellFor(id).then(({ connect }) => {
    conn = connect((frame) => on.message(JSON.stringify(frame)));
    on.open();
  });
  return { send: (data) => void ready.then(() => conn!.message(data)), close: () => void ready.then(() => conn!.close()) };
};

let created = 0;
const artifact = { id: "a1", session: "s1", title: "Plan", kind: "markdown", language: null, version: 2, createdAt: 1, updatedAt: 2 };
const fetch = async (req: Request) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/api/sessions" && req.method === "POST") {
    created++;
    return Response.json({ id: `new${created}`, name: "untitled", cwd: "/workspace", createdAt: 3 });
  }
  if (pathname === "/api/sessions") return Response.json([{ id: "s1", name: "Fix login", cwd: "/workspace", createdAt: 1, status: "idle", lastActivity: 2 }]);
  if (pathname === "/api/artifacts") return Response.json([artifact]);
  if (pathname === "/api/artifacts/a1") return Response.json({ ...artifact, content: "# Plan\n\nStep one." });
  return Response.json({ error: "not found" }, { status: 404 });
};

const ext = remoteExtension("http://boxen.test", { fetch, transport });
const memos = new Map<string, unknown>();
const call = async (name: string, args: object, taskId = "t1") => {
  const tool = ext.tools!.find((t) => t.name === name)!;
  const api = {
    taskId,
    output() {},
    memo: async (key: string, ...rest: unknown[]) => {
      const k = `${taskId}:${key}`;
      if (rest.length === 2 && !memos.has(k)) memos.set(k, rest[0]);
      return memos.get(k);
    },
  };
  const result = await (tool.execute as Function)(args, api, ctx);
  return result.content.map((c: { text: string }) => c.text).join("");
};
const idle = async (id: string) => (await cellFor(id)).agent.harness.waitForIdle(ctx);
// User messages in the transcript, from a fresh join as a browser would see it.
const userMessages = async (id: string) => {
  const client = sessionClient(`ws://boxen.test/api/session/${id}/ws`, { transport });
  const stop = client.connect();
  while (!client.state().ready) await new Promise((r) => setTimeout(r, 10));
  const n = client.state().model.items.filter((i) => i.kind === "user").length;
  stop();
  return n;
};

assert.match(await call("list_sessions", {}), /s1 {2}idle {2}"Fix login"/);

// Work handed off, then a check-in on it.
faux.setResponses([fauxAssistantMessage("Found the bug in auth.ts.")]);
assert.equal(await call("send_to_session", { session: "s1", prompt: "Why does login fail?" }, "t1"), "Sent to Session s1.");
await idle("s1");
const report = await call("check_session", { session: "s1" });
assert.match(report, /idle/);
assert.match(report, /Latest request: Why does login fail\?/);
assert.match(report, /Latest answer:\nFound the bug in auth\.ts\./);

// A rerun of the same call (a restart mid-tool) is the same prompt: dropped.
assert.equal(await userMessages("s1"), 1);
await call("send_to_session", { session: "s1", prompt: "Why does login fail?" }, "t1");
await idle("s1");
assert.equal(await userMessages("s1"), 1, "the resent prompt was deduplicated");

// start_session: one Session per call, even when the call reruns.
faux.setResponses([fauxAssistantMessage("On it.")]);
assert.match(await call("start_session", { prompt: "Add a test", repo: "https://github.com/x/y" }, "t2"), /Started Session new1/);
await call("start_session", { prompt: "Add a test", repo: "https://github.com/x/y" }, "t2");
assert.equal(created, 1, "a rerun reused the Session in its memo");
await idle("new1");
assert.match(await call("check_session", { session: "new1" }), /Latest answer:\nOn it\./);

assert.match(await call("list_artifacts", { session: "s1" }), /a1 {2}markdown v2 {2}"Plan"/);
assert.match(await call("read_artifact", { id: "a1" }), /"Plan" \(markdown v2\)\n\n# Plan/);

for (const { agent } of sessions.values()) await agent.harness.close(ctx);

// github: GET only, token attached, links dropped but html_url, never off the API.
const seen: { url: string; headers: Record<string, string> }[] = [];
const gh = githubExtension(async () => "ghp_test", async (input, init) => {
  seen.push({ url: String(input), headers: init?.headers as Record<string, string> });
  if (String(input).endsWith("/nope")) return new Response('{"message":"Not Found"}', { status: 404 });
  if ((init?.headers as Record<string, string>).accept.includes("diff")) return new Response("diff --git a/x b/x");
  return Response.json([{ sha: "abc", url: "https://api…", html_url: "https://github.com/o/r/commit/abc", node_id: "N", author: { login: "neil", avatar_url: "x" } }]);
});
const ghCall = async (args: object) => {
  const result = await (gh.tools![0].execute as Function)(args, {}, ctx);
  return result.content[0].text as string;
};
assert.equal(await ghCall({ path: "/repos/o/r/commits?per_page=1" }),
  '[{"sha":"abc","html_url":"https://github.com/o/r/commit/abc","author":{"login":"neil"}}]');
assert.equal(seen[0].url, "https://api.github.com/repos/o/r/commits?per_page=1");
assert.equal(seen[0].headers.authorization, "Bearer ghp_test");
assert.equal(await ghCall({ path: "/repos/o/r/pulls/1", format: "diff" }), "diff --git a/x b/x");
for (const path of ["//evil.example/x", "https://evil.example/x", "repos/o/r"]) {
  await assert.rejects(ghCall({ path }), /path must be a path on api\.github\.com/);
}
assert.equal(seen.length, 2, "nothing left the API");
await assert.rejects(ghCall({ path: "/nope" }), /GitHub 404: \{"message":"Not Found"\}/);

console.log("remote.check: ok");
