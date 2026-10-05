#!/usr/bin/env node
// The MCP server: lets an external agent (Claude Code, pi, …) list and create
// Sessions, run a turn, and read artifacts. It knows no API of its own: REST
// and turns go through @pi-durable-sessions/client's system(), as in pds.
//
//   PDS_URL=http://127.0.0.1:8093 node apps/mcp/server.ts    (stdio)
//
// Progress: when the caller sends a progress token, run_turn reports one
// notification per step of the turn, not per token: the join, each tool call
// as it starts, each piece of text the agent finishes. Cancelling the request
// aborts the turn.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CancelledNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_URL, sessionSocketUrl, system, webSocketTransport, type Transport, type TurnResult } from "@pi-durable-sessions/client";
import { z } from "zod";

const CONNECT_MS = 15_000;
const ABORT_MS = 5_000;

export interface Deps {
  fetch?: (request: Request) => Promise<Response>;
  transport: Transport;
  connectMs?: number; // how long run_turn waits for the Session to join
  abortMs?: number; // how long a cancelled run_turn waits for the Session to confirm the abort
}

const SESSION = "A Session is one coding agent with its own sandbox (a container with a /workspace directory, optionally a cloned git repo) and a durable transcript; it keeps both between turns.";

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failed = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
// An API call's result (as JSON by default), or its failure as the tool's
// error: the worker's message, and a failed fetch's cause (what it could not reach).
const call = async <T>(request: () => Promise<T>, render: (value: T) => CallToolResult = json): Promise<CallToolResult> => {
  let value: T;
  try { value = await request(); } catch (e) {
    const { message, cause } = e as Error;
    return failed(`${message}${cause instanceof Error ? ` (${cause.message})` : ""}`);
  }
  return render(value);
};
const clip = (s: string, n = 120) => { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function createServer(url: string, deps: Deps) {
  const { api, session } = system(url, deps);
  const server = new McpServer({ name: "pi-durable-sessions", version: "0.1.0" });
  // Workaround: @modelcontextprotocol/sdk 1.32.0 (Protocol._oncancel) drops a
  // cancel whose requestId is falsy, so request 0, a valid JSON-RPC id, could
  // not be cancelled and its turn ran on. This handler does what the SDK's
  // does for every id. Remove it once the 1.x SDK checks for undefined, as
  // the v2 @modelcontextprotocol/server (2.3.0) already does.
  const pending = (server.server as unknown as { _requestHandlerAbortControllers?: Map<unknown, AbortController> })._requestHandlerAbortControllers;
  if (!(pending instanceof Map)) throw new Error("@modelcontextprotocol/sdk changed: revisit the request-0 cancel workaround in server.ts");
  server.server.setNotificationHandler(CancelledNotificationSchema, ({ params }) => { pending.get(params.requestId)?.abort(params.reason); });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("list_sessions", {
    description: `${SESSION} Lists every Session on the system, most recently active first. Returns a JSON array; each item has id (pass it to run_turn and list_artifacts), name, status ("running" while a turn is in progress, "idle" otherwise), repo, branch, createdAt and lastActivity (milliseconds since the epoch), and archivedAt when the Session was archived (hidden in the web app, still usable). Use it to find a Session to continue, or to check whether a turn whose outcome you lost is still running.`,
    annotations: readOnly,
  }, () => call(api.listSessions));

  server.registerTool("create_session", {
    description: `${SESSION} Creates a new, idle Session and returns it as JSON ({ id, name, cwd, repo, branch, createdAt }); pass its id to run_turn to give it work. Sessions cannot be deleted through this server, so reuse one from list_sessions when it fits.`,
    inputSchema: {
      name: z.string().optional().describe("A name to show in the Session list; without one, the first prompt titles the Session"),
      repo: z.string().optional().describe("A git URL to clone into /workspace/<repo name> before the first turn"),
      branch: z.string().optional().describe("The branch of repo to check out; the default branch when omitted"),
    },
  }, ({ name, repo, branch }) => call(() => api.createSession({ name, repo, branch })));

  server.registerTool("run_turn", {
    description: `${SESSION} Sends a prompt to a Session's agent and waits until the agent has finished answering it (one turn), then returns the answer's text. The agent works in its sandbox meanwhile: it may run commands, edit files and save artifacts, so a turn can take minutes and spends model credits. If the Session is already busy with another turn, the prompt is delivered into that turn. Progress notifications report each tool call and each finished piece of text while it runs. Cancelling this call aborts the agent's whole current run in that Session, not only this prompt. Results other than an answer come back as errors: the turn failed (the reason is given), it was aborted (by you, by anyone else watching the Session, or because the turn the prompt was delivered into ended before taking it in), or the connection dropped mid-turn, in which case the outcome is unknown and the turn may still be running; the result says how to find out. Do not simply resend a prompt after a dropped connection.`,
    inputSchema: {
      session: z.string().describe("The Session's id, from list_sessions or create_session"),
      prompt: z.string().min(1).describe("What to ask the agent, as you would type it in a chat"),
    },
  }, async ({ session: id, prompt }, { signal, _meta, sendNotification }) => {
    const client = session(id);
    const { connectMs = CONNECT_MS, abortMs = ABORT_MS } = deps;

    // Progress, when asked for: one message per step of the turn.
    const token = _meta?.progressToken;
    let progress = 0;
    const report = (message: string) => {
      if (token === undefined) return;
      sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } }).catch(() => {});
    };
    let from: number | null = null; // the first item seq of this turn, fixed at ready
    const reported = new Set<string>();
    client.subscribe(() => {
      const { model, ready } = client.state();
      if (from === null) {
        if (ready) { from = model.seq; report("connected to the Session; prompt sent"); }
        return;
      }
      for (const item of model.items) {
        if (item.kind !== "assistant" || item.seq < from) continue;
        item.blocks.forEach((b, i) => {
          const key = `${item.seq}.${i}`;
          if (reported.has(key)) return;
          if (b.kind === "tool" && b.state !== "building") report(`tool ${b.name} ${clip(JSON.stringify(b.args ?? b.argsText))}`);
          else if (b.kind === "text" && !b.streaming && b.text.trim()) report(`wrote: ${clip(b.text)}`);
          else return;
          reported.add(key);
        });
      }
    });

    // Bound the wait for the join, not the turn (as pds prompt does). Once
    // cancelled, bound the wait for the cell to settle the abort too: then
    // stop the client, which closes the socket and settles run().
    const cancel = new AbortController();
    let stop = () => {};
    let unconfirmed: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false;
    const abort = () => { cancel.abort(); unconfirmed = setTimeout(() => { abandoned = true; stop(); }, abortMs); };
    signal.addEventListener("abort", abort);
    if (signal.aborted) abort();
    let unreachable = false;
    const giveUp = setTimeout(() => { unreachable = true; cancel.abort(); }, connectMs);
    client.subscribe(() => { if (client.state().ready) clearTimeout(giveUp); });

    let result: TurnResult;
    try {
      stop = client.connect();
      result = await client.run(prompt, { signal: cancel.signal });
    } finally {
      stop();
      clearTimeout(giveUp);
      clearTimeout(unconfirmed);
      signal.removeEventListener("abort", abort);
    }
    if (unreachable) return failed(`Could not reach the Session: no connection to ${sessionSocketUrl(url, id)} in ${connectMs / 1000} s. Nothing was sent. Check the id with list_sessions; if it is right, the system may be down.`);
    if (abandoned && result.status === "disconnected") return failed(`Cancelled: the abort was sent to Session ${id}, but it did not confirm within ${abortMs / 1000} s, so the turn may still be running. Call list_sessions and look at this Session's status.`);
    switch (result.status) {
      case "done": return { content: [{ type: "text", text: result.text || "(The turn ended without a text answer.)" }] };
      case "error": return failed(`The turn failed: ${result.error}`);
      case "aborted": return failed("The turn was aborted: by this call's cancellation, by someone else stopping the Session, or because the Session's turn this prompt was delivered into ended (stopped or failed) before taking it in; in that last case run_turn again if it still applies. Whatever the agent did before that (commands run, files changed) stays in its sandbox.");
      case "disconnected": return failed(`Outcome unknown: the connection to Session ${id} dropped after the prompt was sent, and the turn may still be running there; the Session keeps its transcript either way. Call list_sessions and look at this Session's status: "running" means the turn is still going, "idle" means it has ended. Once it is idle, run_turn asking the agent to repeat its last answer, rather than resending the original prompt, which would make it do the work again.`);
    }
  });

  server.registerTool("list_artifacts", {
    description: `${SESSION} Agents save documents they produce (plans, reports, diagrams, pages, code) as artifacts, each with a title, a kind (markdown, html, svg, mermaid or code) and numbered versions. Lists artifacts without their content, most recently updated first: one Session's when session is given, otherwise every Session's (at most 200). Returns a JSON array of { id, session, title, kind, language, version, createdAt, updatedAt }. Read one with read_artifact; to find artifacts by their text, use search_artifacts.`,
    inputSchema: { session: z.string().optional().describe("A Session id; omit to list every Session's artifacts") },
    annotations: readOnly,
  }, ({ session }) => call(() => api.listArtifacts({ session })));

  server.registerTool("search_artifacts", {
    description: `${SESSION} Agents save documents they produce as artifacts. Searches the titles and contents of every Session's artifacts, best match first (at most 50); an artifact matches when it contains every word of the query, each as a word or the start of one (punctuation is ignored). Returns a JSON array of { id, session, title, kind, version, updatedAt, snippet }, where snippet is a piece of the content with the matches in [brackets]. Read a result with read_artifact.`,
    inputSchema: { query: z.string().min(1).describe("Search terms, e.g. a few words you expect in the text") },
    annotations: readOnly,
  }, ({ query }) => call(() => api.listArtifacts({ q: query })));

  server.registerTool("read_artifact", {
    description: `${SESSION} Agents save documents they produce as artifacts. Reads one artifact: the first part of the result is its details as JSON ({ id, session, title, kind, language, version, createdAt, updatedAt }), the second its content, verbatim (markdown, a complete HTML page, SVG, mermaid source, or code in language). Gets the latest version unless version is given.`,
    inputSchema: {
      artifact: z.string().describe("The artifact's id, from list_artifacts or search_artifacts"),
      version: z.number().int().min(1).optional().describe("An earlier version number; omit for the latest"),
    },
    annotations: readOnly,
  }, ({ artifact, version }) => call(() => api.getArtifact(artifact, version), ({ content, ...details }) =>
    ({ content: [{ type: "text", text: JSON.stringify(details, null, 2) }, { type: "text", text: content }] })));

  return server;
}

if (import.meta.main) {
  const url = process.env.PDS_URL ?? DEFAULT_URL;
  if (!/^https?:$/.test(URL.parse(url)?.protocol ?? "")) {
    process.stderr.write(`pds-mcp: PDS_URL must be http(s): ${url}\n`);
    process.exit(2);
  }
  const server = createServer(url, { transport: webSocketTransport });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`pds-mcp: serving ${url} on stdio\n`);
  // Shut down when the client does: SDK 1.32.0's stdio transport ignores the
  // end of stdin. Closing the server aborts requests in flight, so a running
  // turn is aborted in its Session, and the process exits once they settle.
  const close = () => void server.close();
  process.stdin.once("end", close);
  process.once("SIGTERM", close);
  process.once("SIGINT", close); // a second Ctrl-C kills
}
