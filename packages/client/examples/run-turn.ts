// Runs one turn on a Session from Node, with no browser: streams the reply to
// stdout and exits 0 when the turn is done, 1 otherwise (status on stderr).
// Ctrl-C aborts the turn.
//
//   node examples/run-turn.ts <base-url> <prompt> [session-id]
//
// Without a session id it creates a Session. Against a live system this
// spends model credits and leaves the Session behind.
import { apiClient, sessionClient, webSocketTransport } from "@pi-durable-sessions/client";

const [base, text, id] = process.argv.slice(2);
if (!base || !text) {
  console.error("usage: node examples/run-turn.ts <base-url> <prompt> [session-id]");
  process.exit(2);
}

const session = id ?? (await apiClient(base).createSession({})).id;
console.error(`session ${session}`);
const client = sessionClient(`${base.replace(/^http/, "ws")}/api/session/${session}/ws`, { transport: webSocketTransport });

// Progress: print each new assistant message's text as it grows.
let from: number | null = null; // the first item seq of this turn, fixed at ready
let item = -1;
let printed = 0;
client.subscribe(() => {
  const { model, ready } = client.state();
  if (from === null) { if (ready) from = model.seq; return; }
  const last = model.items.at(-1);
  if (last?.kind !== "assistant" || last.seq < from) return;
  if (last.seq !== item) { if (item >= 0) process.stdout.write("\n"); item = last.seq; printed = 0; }
  const reply = last.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
  process.stdout.write(reply.slice(printed));
  printed = Math.max(printed, reply.length);
});

const cancel = new AbortController();
process.once("SIGINT", () => cancel.abort());
const stop = client.connect();
const result = await client.run(text, { signal: cancel.signal });
stop();
process.stdout.write("\n");
console.error(result.status === "error" ? `error: ${result.error}` : result.status);
process.exit(result.status === "done" ? 0 : 1);
