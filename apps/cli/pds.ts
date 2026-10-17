#!/usr/bin/env node
// pds: the one command line for a pi-durable-sessions system. It knows no API
// of its own: Sessions go through @pi-durable-sessions/client, REST through
// apiClient and turns through the session client's run(). `--json` makes
// every command print one JSON value on stdout; diagnostics go to stderr.
//
//   pds <command> [options]     pds help for the list
//
// Exit codes: 0 success, 1 failure (an API error, or a turn that did not end
// `done`), 2 bad usage.
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { DEFAULT_URL, sessionSocketUrl, system as connect, webSocketTransport, type CreateSession, type Transport, type TurnResult } from "@pi-durable-sessions/client";

import pkg from "./package.json" with { type: "json" };

const CONNECT_MS = 15_000;

// Everything outside the process that a command touches, so cli.check.ts can
// run them with no backend.
export interface Deps {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  transport: Transport;
  fetch?: (request: Request) => Promise<Response>;
  signal?: AbortSignal; // Ctrl-C: aborts a running turn
  connectMs?: number; // how long prompt waits for the Session to join
}

interface Ctx {
  url: string;
  json: boolean;
  deps: Deps;
}

// Requests to the system go through the client's system(), where auth will attach.
const system = ({ url, deps }: Ctx) => connect(url, deps);

const print = (ctx: Ctx, value: unknown, text: string) => ctx.deps.out(ctx.json ? `${JSON.stringify(value)}\n` : text);

interface Command {
  args: string; // for the usage line
  summary: string;
  options?: ParseArgsOptionsConfig; // beyond --url, --json, --help
  positionals?: true; // takes arguments; otherwise any is a usage error
  run(ctx: Ctx, values: Record<string, unknown>, positionals: string[]): Promise<number>;
}

// The commands, grouped as `pds help` lists them. The operations commands of
// #68 (start, stop, deploy, status, logs) go in this table as a second group,
// "System", so the one binary runs both the product and the system. They
// will read the runtime settings rather than the API, so they skip system();
// --url and --json apply to them as to these.
const groups: Record<string, Record<string, Command>> = {
  Sessions: {
    list: {
      args: "",
      summary: "list Sessions, most recently active first (id, status, name)",
      async run(ctx) {
        const sessions = await system(ctx).api.listSessions();
        const row = (s: (typeof sessions)[number]) => `${s.id}\t${s.archivedAt ? "archived" : s.status ?? ""}\t${s.name}\n`;
        print(ctx, sessions, sessions.map(row).join(""));
        return 0;
      },
    },
    create: {
      args: "[--name <name>] [--repo <git-url>] [--branch <branch>]",
      summary: "create a Session and print its id",
      options: { name: { type: "string" }, repo: { type: "string" }, branch: { type: "string" } },
      async run(ctx, { name, repo, branch }) {
        const session = await system(ctx).api.createSession({ name, repo, branch } as CreateSession);
        print(ctx, session, `${session.id}\n`);
        return 0;
      },
    },
    prompt: {
      args: "<session-id> <text...>",
      summary: "send a prompt, stream the reply, exit 0 when the turn is done",
      positionals: true,
      async run(ctx, _, [id, ...words]) {
        const text = words.join(" ");
        if (!id || !text) return usage(ctx.deps, "prompt needs a session id and the text");
        const { out, err, signal, connectMs = CONNECT_MS } = ctx.deps;
        const client = system(ctx).session(id);

        // Progress: print each new assistant message's text as it grows. Best
        // effort: the result has the whole answer. JSON mode prints only that.
        let from: number | null = null; // the first item seq of this turn, fixed at ready
        let item = -1;
        let shown = ""; // what is printed of item `item`
        if (!ctx.json) client.subscribe(() => {
          const { model, ready } = client.state();
          if (from === null) { if (ready) from = model.seq; return; }
          const last = model.items.at(-1);
          if (last?.kind !== "assistant" || last.seq < from) return;
          if (last.seq !== item) { if (item >= 0) out("\n"); item = last.seq; shown = ""; }
          const reply = last.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
          if (!reply.startsWith(shown)) return;
          out(reply.slice(shown.length));
          shown = reply;
        });

        // Bound the wait for the join, not the turn.
        const cancel = new AbortController();
        const abort = () => cancel.abort();
        signal?.addEventListener("abort", abort);
        if (signal?.aborted) abort();
        let unreachable = false;
        const giveUp = setTimeout(() => { unreachable = true; cancel.abort(); }, connectMs);
        client.subscribe(() => { if (client.state().ready) clearTimeout(giveUp); });

        // Clean up on every way out, a throw from connect() included: a
        // timer or a socket left behind would keep the process alive.
        let result: TurnResult;
        let stop = () => {};
        try {
          stop = client.connect();
          result = await client.run(text, { signal: cancel.signal });
        } finally {
          stop();
          clearTimeout(giveUp);
          signal?.removeEventListener("abort", abort);
        }
        if (unreachable) result = { status: "error", error: `no connection to ${sessionSocketUrl(ctx.url, id)} in ${connectMs / 1000} s` };

        if (ctx.json) out(`${JSON.stringify(result)}\n`);
        else {
          // End with the whole answer: whatever of it streaming did not print.
          if (result.status === "done") out(result.text.startsWith(shown) ? result.text.slice(shown.length) : `${item >= 0 ? "\n" : ""}${result.text}`);
          if (result.status === "done" || item >= 0) out("\n");
          if (result.status === "error") err(`error: ${result.error}\n`);
          if (result.status === "aborted") err("aborted\n");
          if (result.status === "disconnected") err("disconnected: the outcome is unknown and the turn may still be running\n");
        }
        return result.status === "done" ? 0 : 1;
      },
    },
  },
};
const commands: Record<string, Command> = Object.assign({}, ...Object.values(groups));

const common = {
  url: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptionsConfig;

function help() {
  const lines = ["usage: pds <command> [options]", ""];
  for (const [group, cmds] of Object.entries(groups)) {
    lines.push(`${group}:`);
    for (const [name, c] of Object.entries(cmds)) lines.push(`  pds ${name} ${c.args}`.trimEnd(), `      ${c.summary}`);
    lines.push("");
  }
  lines.push(
    "  pds --version   local CLI application version (not the running server)",
    "",
    "Options for every command:",
    `  --url <url>   the system (default: $PDS_URL, else ${DEFAULT_URL})`,
    "  --json        print one JSON value on stdout",
    "  -h, --help    this help",
    "",
  );
  return lines.join("\n");
}

function usage(deps: Deps, message: string) {
  deps.err(`pds: ${message}\n\n${help()}`);
  return 2;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const [name, ...rest] = argv;
  if (!name) return usage(deps, "no command");
  if (name === "--version" && rest.length === 0) { deps.out(`pi-durable-sessions ${pkg.version} (local CLI)\n`); return 0; }
  if (name === "help" || name === "--help" || name === "-h") { deps.out(help()); return 0; }
  const command = commands[name];
  if (!command) return usage(deps, `unknown command: ${name}`);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...common, ...command.options }, allowPositionals: !!command.positionals, strict: true });
  } catch (e) {
    return usage(deps, (e as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) { deps.out(help()); return 0; }
  const url = (values.url as string | undefined) ?? deps.env.PDS_URL ?? DEFAULT_URL;
  if (!/^https?:$/.test(URL.parse(url)?.protocol ?? "")) return usage(deps, `the system's URL must be http(s): ${url}`);
  try {
    return await command.run({ url, json: !!values.json, deps }, values, positionals);
  } catch (e) {
    // apiClient's Error carries the worker's message; a failed fetch its cause.
    const { message, cause } = e as Error;
    deps.err(`pds: ${url}: ${message}${cause instanceof Error ? ` (${cause.message})` : ""}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const ctrlC = new AbortController();
  process.once("SIGINT", () => ctrlC.abort()); // a second Ctrl-C kills
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    transport: webSocketTransport,
    signal: ctrlC.signal,
  });
}
