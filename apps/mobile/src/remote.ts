// Tools for the coding Sessions of the boxen system this app
// is served from (same origin): list them, check in on one, start one or
// send it more work, read what they saved. Work is handed off, never waited
// on: a phone is suspended long before a turn ends, so the agent checks back
// with check_session instead (unlike the MCP server's run_turn).
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { system, webSocketTransport, type ChatItem, type SessionClient } from "@boxen/client";

const SESSION = "A Session is a coding agent with its own Linux sandbox on the user's machine, often working in a git repo.";
const JOIN_MS = 10_000;
const SETTLE_MS = 3_000; // how long a sent prompt has to fail before it counts as sent

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const clip = (s: string, n: number) => { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const when = (ms?: number | null) => (ms ? new Date(ms).toISOString() : "never");

// A joined session client for the length of `use`.
async function joined<T>(client: SessionClient, use: (client: SessionClient) => Promise<T>): Promise<T> {
  const stop = client.connect();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("the Session did not answer; check the id with list_sessions")); }, JOIN_MS);
      const off = client.subscribe(() => { if (client.state().ready) { clearTimeout(timer); off(); resolve(); } });
      if (client.state().ready) { clearTimeout(timer); off(); resolve(); }
    });
    return await use(client);
  } finally {
    stop();
  }
}

// Sends a prompt and waits briefly for an error (a refusal, or the run failing
// at once); an admitted prompt runs, or queues behind the running turn,
// whether or not anyone stays connected.
async function send(client: SessionClient, prompt: string, requestId: string) {
  const before = client.state().model.items.length;
  if (!client.prompt(prompt, requestId)) throw new Error("the Session's connection dropped before the prompt went out");
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const failed = client.state().model.items.slice(before).find((i) => i.kind === "system" && i.level === "error");
  if (failed) throw new Error(`the Session reported an error: ${(failed as Extract<ChatItem, { kind: "system" }>).text}`);
}

// What a check-in needs: the latest request and everything since it.
function summary(client: SessionClient) {
  const { model, meta } = client.state();
  const items = model.items;
  const last = items.findLastIndex((i) => i.kind === "user");
  const lines = [
    `Session "${meta?.name}" (${meta?.id}): ${model.running ? "working" : "idle"}` +
      `${meta?.repo ? `, repo ${meta.repo}${meta.branch ? ` @ ${meta.branch}` : ""}` : ""}, last activity ${when(meta?.lastActivity)}`,
    `Model: ${model.agent.model ? `${model.agent.model.provider}/${model.agent.model.modelId}` : "none"}`,
  ];
  if (last < 0) return [...lines, "No requests yet."].join("\n");
  lines.push(`Latest request: ${clip((items[last] as Extract<ChatItem, { kind: "user" }>).text, 500)}`);
  let answer = "";
  for (const item of items.slice(last + 1)) {
    if (item.kind === "user") lines.push(`Then: ${clip(item.text, 300)}`);
    if (item.kind === "system" && item.level === "error") lines.push(`Error: ${clip(item.text, 300)}`);
    if (item.kind !== "assistant") continue;
    for (const b of item.blocks) {
      if (b.kind === "tool") lines.push(`- ${b.name} ${clip(JSON.stringify(b.args ?? b.argsText), 160)}${b.isError ? " (failed)" : b.state === "done" ? "" : " (running)"}`);
      if (b.kind === "text" && b.text.trim()) answer = b.text;
    }
  }
  if (answer) lines.push(`Latest answer:\n${clip(answer, 2500)}`);
  return lines.join("\n");
}

// `deps` as system() takes them; remote.check.ts passes a fake REST API and an in-process cell.
export function remoteExtension(origin: string, deps: Parameters<typeof system>[1] = { transport: webSocketTransport }) {
  const { api, session } = system(origin, deps);

  return defineExtension({
    name: "sessions",
    sections: [section("sessions", () =>
      "The user runs coding Sessions on their own machine. With the Session tools you can check on them, " +
      "start new ones, and send them work. You hand work off and check back later; you don't wait for it.")],
    tools: [
      defineTool({
        name: "list_sessions",
        description: `${SESSION} Lists the Sessions, most recently active first: id, name, status ("running" while a turn is in progress), repo, branch, last activity. Archived ones only when asked.`,
        parameters: Type.Object({ archived: Type.Optional(Type.Boolean({ description: "Include archived Sessions" })) }),
        execute: async ({ archived }) => {
          const list = (await api.listSessions()).filter((s) => archived || s.archivedAt == null);
          return text(list.map((s) => `${s.id}  ${s.status ?? "idle"}  "${s.name}"${s.repo ? `  ${s.repo}${s.branch ? `@${s.branch}` : ""}` : ""}  last ${when(s.lastActivity)}`).join("\n") || "No Sessions.");
        },
      }),
      defineTool({
        name: "check_session",
        description: `${SESSION} Checks in on one: whether it is working, its latest request, the tool calls and errors since, and its latest answer. Use it to report progress; it does not change the Session.`,
        parameters: Type.Object({ session: Type.String({ description: "The Session's id, from list_sessions" }) }),
        replay: "safe",
        execute: async ({ session: id }) => {
          const summaryText = await joined(session(id), async (client) => summary(client));
          return { ...text(summaryText), details: { sessionId: id } };
        },
      }),
      defineTool({
        name: "start_session",
        description: `${SESSION} Starts a new Session and gives it work, then returns at once with its id; the work goes on there. Check on it later with check_session. Write the prompt as a complete brief: the Session sees nothing of this conversation.`,
        parameters: Type.Object({
          prompt: Type.String({ description: "The task, self-contained" }),
          repo: Type.Optional(Type.String({ description: "A git URL to clone into the sandbox first" })),
          branch: Type.Optional(Type.String({ description: "The branch of repo; the default branch when omitted" })),
          name: Type.Optional(Type.String({ description: "A name for the Session list; the prompt titles it otherwise" })),
        }),
        // A rerun after a crash finds the Session in the call's memo and the
        // Session drops the resent prompt by its requestId.
        // ponytail: a crash between create and memo makes a second Session; create with an idempotency key if that bites.
        replay: "safe",
        execute: async ({ prompt, repo, branch, name }, toolApi, context) => {
          const id = (await toolApi.memo<string>("session", context))
            ?? await toolApi.memo("session", (await api.createSession({ name, repo, branch })).id, context);
          await joined(session(id), (client) => send(client, prompt, `phone:${toolApi.taskId}`));
          return { ...text(`Started Session ${id} with the prompt. It is working now; check on it with check_session.`), details: { sessionId: id } };
        },
      }),
      defineTool({
        name: "send_to_session",
        description: `${SESSION} Sends an existing Session more work and returns at once. While it is working, the message steers the current turn; otherwise it starts a new one. Check on it later with check_session.`,
        parameters: Type.Object({
          session: Type.String({ description: "The Session's id" }),
          prompt: Type.String({ description: "The message, as you would type it in its chat" }),
        }),
        // The requestId is the call's own, so the Session drops a rerun's resend.
        replay: "safe",
        execute: async ({ session: id, prompt }, toolApi) => {
          await joined(session(id), (client) => send(client, prompt, `phone:${toolApi.taskId}`));
          return { ...text(`Sent to Session ${id}.`), details: { sessionId: id } };
        },
      }),
      defineTool({
        name: "list_artifacts",
        description: "Lists the documents Sessions saved (plans, reports, diagrams, pages, code), newest first: one Session's, or with a query, those whose text matches.",
        parameters: Type.Object({
          session: Type.Optional(Type.String({ description: "Only this Session's" })),
          query: Type.Optional(Type.String({ description: "Full-text search" })),
        }),
        execute: async ({ session: id, query }) => {
          const list = await api.listArtifacts({ session: id, q: query });
          return text(list.map((a) => `${a.id}  ${a.kind} v${a.version}  "${a.title}"  session ${a.session}  ${when(a.updatedAt)}`).join("\n") || "No artifacts.");
        },
      }),
      defineTool({
        name: "read_artifact",
        description: "Reads one saved artifact's content, the latest version unless one is given.",
        parameters: Type.Object({
          id: Type.String({ description: "The artifact's id, from list_artifacts" }),
          version: Type.Optional(Type.Number()),
        }),
        execute: async ({ id, version }) => {
          const a = await api.getArtifact(id, version);
          return text(`"${a.title}" (${a.kind} v${a.version})\n\n${a.content}`);
        },
      }),
    ],
  });
}
