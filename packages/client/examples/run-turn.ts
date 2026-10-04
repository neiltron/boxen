// Runs one turn on a Session from Node, with no browser: streams the reply to
// stdout and exits 0 when the turn is done, 1 otherwise (status on stderr).
// Ctrl-C aborts the turn. Gives up after 15 s without a connection.
//
//   node examples/run-turn.ts <base-url> <prompt> [session-id]
//
// Without a session id it creates a Session. Against a live system this
// spends model credits and leaves the Session behind.
import { apiClient, sessionClient, sessionSocketUrl, webSocketTransport } from "@pi-durable-sessions/client";

const CONNECT_MS = 15_000;
const [base, text, id] = process.argv.slice(2);
if (!base || !text) {
  console.error("usage: node examples/run-turn.ts <base-url> <prompt> [session-id]");
  process.exit(2);
}

const fail = (message: string): never => { console.error(message); process.exit(1); };
const session = id ?? (await apiClient(base).createSession({}).catch((e) => fail(`creating a Session at ${base}: ${e.message}`))).id;
console.error(`session ${session}`);
const url = sessionSocketUrl(base, session);
const client = sessionClient(url, { transport: webSocketTransport });

// Progress: print each new assistant message's text as it grows. Best effort:
// the result below has the whole answer.
let from: number | null = null; // the first item seq of this turn, fixed at ready
let item = -1;
let shown = ""; // what is printed of item `item`
client.subscribe(() => {
  const { model, ready } = client.state();
  if (from === null) { if (ready) from = model.seq; return; }
  const last = model.items.at(-1);
  if (last?.kind !== "assistant" || last.seq < from) return;
  if (last.seq !== item) { if (item >= 0) process.stdout.write("\n"); item = last.seq; shown = ""; }
  const reply = last.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
  if (!reply.startsWith(shown)) return;
  process.stdout.write(reply.slice(shown.length));
  shown = reply;
});

const cancel = new AbortController();
process.once("SIGINT", () => cancel.abort());
let unreachable = false;
const giveUp = setTimeout(() => { unreachable = true; cancel.abort(); }, CONNECT_MS);
client.subscribe(() => { if (client.state().ready) clearTimeout(giveUp); });

const stop = client.connect();
const result = await client.run(text, { signal: cancel.signal });
stop();
// End with the whole answer: whatever of it streaming did not print.
if (result.status === "done") {
  process.stdout.write(result.text.startsWith(shown) ? result.text.slice(shown.length) : `${item >= 0 ? "\n" : ""}${result.text}`);
}
process.stdout.write("\n");
if (unreachable) fail(`no connection to ${url} in ${CONNECT_MS / 1000} s`);
console.error(result.status === "error" ? `error: ${result.error}` : result.status);
process.exit(result.status === "done" ? 0 : 1);
