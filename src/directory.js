// Directory — singleton registry cell the sidebar reads. Session cells report
// registrations, renames, and status changes here; subscribers get the full
// list pushed over WebSocket (throttled). It also owns the model login: the
// sign-in runs here, and every Session cell reads (and refreshes) credentials
// through it. The login is the fleet's own, never copied from the host's pi.
import { DurableObject } from "cloudflare:workers";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { directoryCredentials } from "./credentials.js";

// The model a fresh login starts sessions on, per provider.
const DEFAULT_MODELS = { openai: "gpt-6-astra", "openai-codex": "gpt-6-astra" };

export class Directory extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY, name TEXT, cwd TEXT, status TEXT,
      createdAt INT, lastActivity INT)`);
    for (const col of ["repo", "branch"]) {
      try { this.sql.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS credentials(
      provider TEXT PRIMARY KEY, json TEXT)`);
    this.sockets = [];
    this.flushTimer = null;
    this.login = null; // { abort, answer, done } while a sign-in waits on the browser
  }

  async register({ id, name, cwd, repo, branch, createdAt }) {
    this.sql.exec(
      `INSERT OR REPLACE INTO sessions(id, name, cwd, repo, branch, status, createdAt, lastActivity)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, name, cwd, repo ?? null, branch ?? null, "idle", createdAt, createdAt,
    );
    this.notify();
  }

  async touch({ id, status }) {
    if (status) {
      this.sql.exec(`UPDATE sessions SET status = ?, lastActivity = ? WHERE id = ?`,
        status, Date.now(), id);
    } else {
      this.sql.exec(`UPDATE sessions SET lastActivity = ? WHERE id = ?`, Date.now(), id);
    }
    this.notify();
  }

  async rename({ id, name }) {
    this.sql.exec(`UPDATE sessions SET name = ? WHERE id = ?`, name, id);
    this.notify();
  }

  // POST /api/auth/login streams NDJSON: first what the browser must do
  // ({url}), then {done} or {error}. The response stays open for the whole
  // sign-in because I/O here belongs to the request that started it: a token
  // exchange begun under a finished request never completes.
  loginStream(provider) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (msg) => writer.write(encoder.encode(`${JSON.stringify(msg)}\n`)).catch(() => {});
    const keepalive = setInterval(() => send({}), 15000);
    (async () => {
      try {
        const step = await this.loginStart(provider);
        await send(step);
        if (!step.done) await this.login?.done;
        await send({ done: true });
      } catch (e) {
        await send({ error: e.message });
      } finally {
        clearInterval(keepalive);
        writer.close().catch(() => {});
      }
    })();
    return new Response(readable, { headers: { "content-type": "application/x-ndjson" } });
  }

  // Starts an OAuth sign-in and resolves with what the browser must do: open
  // `url`, then paste back the 127.0.0.1:1455 redirect it lands on (nothing
  // listens there; the cell finishes the exchange with the pasted URL).
  async loginStart(provider) {
    this.login?.abort.abort();
    const abort = new AbortController();
    const login = { abort, answer: null };
    this.login = login;
    const deviceId = (await this.state.storage.get("deviceId")) ?? crypto.randomUUID();
    await this.state.storage.put("deviceId", deviceId);
    const models = builtinModels({ credentials: directoryCredentials(this) });
    const step = Promise.withResolvers();
    const interaction = {
      signal: abort.signal,
      notify: (ev) => {
        if (ev.type === "auth_url") step.resolve({ url: ev.url });
        else if (ev.type === "device_code") step.resolve({ url: ev.verificationUri, code: ev.userCode });
      },
      prompt: () => new Promise((resolve) => { login.answer = resolve; }),
    };
    login.done = models.login(provider, "oauth", interaction, { getDeviceId: () => deviceId })
      .then(async () => {
        if (!(await this.state.storage.get("agent")) && DEFAULT_MODELS[provider]) {
          await this.state.storage.put("agent", { model: { provider, modelId: DEFAULT_MODELS[provider] }, thinkingLevel: "high" });
        }
        this.notify();
      })
      .finally(() => { if (this.login === login) this.login = null; });
    login.done.catch(() => {});
    return Promise.race([step.promise, login.done.then(() => ({ done: true }))]);
  }

  async loginFinish(redirectUrl) {
    const login = this.login;
    if (!login?.answer) throw new Error("no sign-in is waiting; start again");
    login.answer(redirectUrl);
    await login.done;
    return this.authStatus();
  }

  async logout(provider) {
    await this.deleteCredential(provider);
    const agent = await this.state.storage.get("agent");
    if (agent?.model?.provider === provider) await this.state.storage.delete("agent");
    this.notify();
    return this.authStatus();
  }

  async authStatus() {
    return { providers: (await this.credentialList()).map((c) => c.providerId), agent: await this.defaultAgent() };
  }

  // Tokens every sandbox command gets (GH_TOKEN, LINEAR_API_KEY), posted by
  // start.sh. Empty values remove a key.
  async setSecrets(secrets) {
    const merged = { ...(await this.secrets()), ...secrets };
    for (const [k, v] of Object.entries(merged)) if (!v) delete merged[k];
    await this.state.storage.put("secrets", merged);
    return Object.keys(merged);
  }

  async secrets() {
    return (await this.state.storage.get("secrets")) ?? {};
  }

  async defaultAgent() {
    return (await this.state.storage.get("agent")) ?? {};
  }

  async credential(provider) {
    const row = this.sql.exec(`SELECT json FROM credentials WHERE provider = ?`, provider).toArray()[0];
    return row ? JSON.parse(row.json) : undefined;
  }

  async setCredential(provider, credential) {
    this.sql.exec(`INSERT OR REPLACE INTO credentials VALUES (?,?)`, provider, JSON.stringify(credential));
  }

  async deleteCredential(provider) {
    this.sql.exec(`DELETE FROM credentials WHERE provider = ?`, provider);
  }

  async credentialList() {
    return this.sql.exec(`SELECT provider, json FROM credentials`).toArray()
      .map((r) => ({ providerId: r.provider, type: JSON.parse(r.json).type }));
  }

  async list() {
    return this.sql.exec(
      `SELECT * FROM sessions ORDER BY lastActivity DESC`).toArray();
  }

  // No frames are sent during the upgrade: Safari drops server frames that
  // arrive before its side of the handshake settles. The client sends "sub"
  // once its socket is open, and the snapshot goes back as a normal message.
  async fetch(request) {
    if (new URL(request.url).pathname === "/api/auth/login") {
      return this.loginStream((await request.json()).provider);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[0]);
    this.sockets.push(pair[0]);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  async webSocketMessage(ws, raw) {
    let cmd;
    try { cmd = JSON.parse(raw); } catch { return; }
    if (cmd.type === "sub") {
      try { ws.send(JSON.stringify({ type: "sessions", sessions: await this.list(), auth: await this.authStatus() })); } catch {}
    }
  }

  async webSocketClose(ws) { this.sockets = this.sockets.filter((s) => s !== ws); }
  async webSocketError(ws) { this.sockets = this.sockets.filter((s) => s !== ws); }

  notify() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      const msg = JSON.stringify({ type: "sessions", sessions: await this.list(), auth: await this.authStatus() });
      this.sockets = this.sockets.filter((ws) => {
        try { ws.send(msg); return true; } catch { return false; }
      });
    }, 150);
  }
}
