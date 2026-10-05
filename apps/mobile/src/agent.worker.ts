// The agent's thread: SQLite in this origin's private file system (OPFS),
// the Harness over it (cell.ts), and the model providers, whose keys live in
// the same database. Every message from the page carries a MessagePort:
// `connect` makes it a Session socket, the rest are one request and its reply.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
// pi-ai loads each provider's request code with import() on first use. Loaded
// here instead, a message talks only to the provider, never back to the server
// that served this app; and a failed import() stays failed until a reload.
import "@earendil-works/pi-ai/api/anthropic-messages";
import "@earendil-works/pi-ai/api/google-generative-ai";
import "@earendil-works/pi-ai/api/openai-completions";
import "@earendil-works/pi-ai/api/openai-responses";
import { openAgent, serve } from "./cell.ts";
import { remoteExtension } from "./remote.ts";
import { chatgptOAuth } from "./chatgpt-oauth.ts";
import { WasmSqlite } from "./wasm-sqlite.ts";

export type WorkerRequest =
  | { type: "connect" }
  | { type: "keys" } // replies with the stored credentials: Connected[]
  | { type: "key"; provider: string; key: string } // an empty key removes it
  | { type: "login"; provider: string } // replies with the sign-in page's url
  | { type: "loginFinish"; redirectUrl: string }; // the address the sign-in ended on

export type Connected = { provider: string; type: Credential["type"] };

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-5-5", openai: "gpt-6-astra",
};

async function start() {
  const sqlite3 = await sqlite3InitModule();
  // ponytail: the pool holds its files exclusively, so a second tab of the app can't open; fine for a home-screen app.
  const pool = await sqlite3.installOpfsSAHPoolVfs({});
  const db = new WasmSqlite(new pool.OpfsSAHPoolDb("/pi.sqlite3"));
  await db.exec("CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, json TEXT NOT NULL)");
  // One ID for this installation, which ChatGPT sign-in names the agent host by.
  await db.exec("CREATE TABLE IF NOT EXISTS device(id TEXT NOT NULL)");
  await db.run("INSERT INTO device SELECT ? WHERE NOT EXISTS (SELECT 1 FROM device)", crypto.randomUUID());
  const deviceId = (await db.get<{ id: string }>("SELECT id FROM device"))!.id;

  const read = async (provider: string) =>
    (await db.get<{ json: string }>("SELECT json FROM credentials WHERE provider = ?", provider))?.json;
  const credentials: CredentialStore = {
    read: async (provider) => { const json = await read(provider); return json ? JSON.parse(json) : undefined; },
    list: async () => (await db.all<{ provider: string; json: string }>("SELECT provider, json FROM credentials"))
      .map((r) => ({ providerId: r.provider, type: (JSON.parse(r.json) as Credential).type })),
    async modify(provider, fn) {
      const current = await credentials.read(provider);
      const next = await fn(current);
      if (next !== undefined) await db.run("INSERT OR REPLACE INTO credentials VALUES (?, ?)", provider, JSON.stringify(next));
      return next ?? current;
    },
    delete: async (provider) => { await db.run("DELETE FROM credentials WHERE provider = ?", provider); },
  };

  const openai = openaiProvider();
  (openai.auth as { oauth?: typeof chatgptOAuth }).oauth = chatgptOAuth; // pi-ai's needs node:http
  const models = createModels({ credentials });
  for (const provider of [anthropicProvider(), openai, openrouterProvider(), googleProvider()]) models.setProvider(provider);
  // The Sessions of the system that served this app, at its own origin.
  const remote = remoteExtension(self.location.origin);
  return { ...(await openAgent(await SqliteStorage.open(db), models, [remote])), credentials, deviceId };
}

const agent = start();
agent.catch((e) => console.error("agent failed to start", e));

// The provider SDKs report any failed fetch as "Connection error." and drop
// the browser's reason, and a phone has no console to read. So the reason goes
// to the screen, once per distinct one, with a probe of the same host to
// tell the network apart from this request.
const nativeFetch = globalThis.fetch.bind(globalThis);
let lastFailure = "";
globalThis.fetch = async (input, init) => {
  try {
    return await nativeFetch(input, init);
  } catch (e) {
    const reason = `${(e as Error).name}: ${(e as Error).message}`;
    if (!init?.signal?.aborted && reason !== lastFailure) {
      lastFailure = reason;
      const url = new URL(input instanceof Request ? input.url : String(input));
      // no-cors: an opaque reply still proves the host is reachable; only the network fails it.
      const probe = await nativeFetch(url.origin, { mode: "no-cors" }).then(
        () => `${url.host} is reachable, so it's this request`,
        (p: Error) => `${url.host} is unreachable from here (${p.message})`,
      );
      connect.broadcast({ type: "error", error: `${init?.method ?? "GET"} ${url.host}${url.pathname} failed: ${reason}; ${probe}` });
    }
    throw e;
  }
};
const connect = serve(agent);

// The first credential picks the model, as the Directory's does on the web.
async function connected(provider: string) {
  const { models, root } = await agent;
  if (!(await root.agent(ctx)).model) {
    const modelId = DEFAULT_MODELS[provider] ?? (await models.getAvailable(provider))[0]?.id;
    if (modelId) await root.configure({ model: { provider, modelId }, thinkingLevel: "medium" }, ctx);
  }
  return requests.keys();
}

// The sign-in in progress, as the Directory's loginStart/loginFinish: the
// flow waits on `answer` for the pasted address.
let login: { provider: string; abort: AbortController; answer: ((url: string) => void) | null; done: Promise<unknown> } | null = null;

const requests = {
  async keys(): Promise<Connected[]> {
    return (await (await agent).credentials.list()).map((c) => ({ provider: c.providerId, type: c.type }));
  },
  async key({ provider, key }: { provider: string; key: string }) {
    const { credentials } = await agent;
    if (!key) {
      await credentials.delete(provider);
      return requests.keys();
    }
    await credentials.modify(provider, async () => ({ type: "api_key", key }));
    return connected(provider);
  },
  async login({ provider }: { provider: string }) {
    const { models, deviceId } = await agent;
    login?.abort.abort();
    const current: NonNullable<typeof login> = { provider, abort: new AbortController(), answer: null, done: Promise.resolve() };
    login = current;
    const url = Promise.withResolvers<string>();
    current.done = models.login(provider, "oauth", {
      signal: current.abort.signal,
      notify: (ev) => { if (ev.type === "auth_url") url.resolve(ev.url); },
      prompt: () => new Promise((resolve) => { current.answer = resolve; }),
    }, { getDeviceId: () => deviceId }).finally(() => { if (login === current) login = null; });
    current.done.catch((e: Error) => url.reject(e));
    return url.promise;
  },
  async loginFinish({ redirectUrl }: { redirectUrl: string }) {
    const current = login;
    if (!current?.answer) throw new Error("No sign-in is waiting; start again");
    current.answer(redirectUrl);
    await current.done;
    return connected(current.provider);
  },
};

// Registered before any await, so no message from the page arrives unheard.
addEventListener("message", (e: MessageEvent<WorkerRequest>) => {
  const [port] = e.ports;
  if (e.data.type === "connect") {
    const conn = connect((frame) => port.postMessage(JSON.stringify(frame)));
    port.onmessage = (m) => (m.data === "close" ? (conn.close(), port.close()) : conn.message(m.data));
    return;
  }
  const { type, ...args } = e.data;
  (requests[type] as (a: typeof args) => Promise<unknown>)(args).then(
    (value) => port.postMessage({ value }),
    (err: Error) => port.postMessage({ error: err.message }),
  );
});
