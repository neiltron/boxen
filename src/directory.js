// Directory — singleton registry cell the sidebar reads. Session cells report
// registrations, renames, and status changes here; subscribers get the full
// list pushed over WebSocket (throttled). It also holds the model login and
// default agent every Session cell runs with, seeded from the host's pi config.
import { DurableObject } from "cloudflare:workers";

export class Directory extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY, name TEXT, cwd TEXT, status TEXT,
      createdAt INT, lastActivity INT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS credentials(
      provider TEXT PRIMARY KEY, json TEXT)`);
    this.sockets = [];
    this.flushTimer = null;
  }

  async register({ id, name, cwd, createdAt }) {
    this.sql.exec(
      `INSERT OR REPLACE INTO sessions(id, name, cwd, status, createdAt, lastActivity)
       VALUES (?,?,?,?,?,?)`,
      id, name, cwd, "idle", createdAt, createdAt,
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

  // Seeds missing credentials only, unless forced: once a cell has refreshed
  // an OAuth token, the host's copy may already be spent.
  async seed({ credentials = {}, agent, force = false }) {
    for (const [provider, credential] of Object.entries(credentials)) {
      this.sql.exec(`INSERT ${force ? "OR REPLACE" : "OR IGNORE"} INTO credentials VALUES (?,?)`,
        provider, JSON.stringify(credential));
    }
    if (agent && (force || !(await this.state.storage.get("agent")))) {
      await this.state.storage.put("agent", agent);
    }
    return { providers: (await this.credentialList()).map((c) => c.providerId) };
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
      try { ws.send(JSON.stringify({ type: "sessions", sessions: await this.list() })); } catch {}
    }
  }

  async webSocketClose(ws) { this.sockets = this.sockets.filter((s) => s !== ws); }
  async webSocketError(ws) { this.sockets = this.sockets.filter((s) => s !== ws); }

  notify() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      const msg = JSON.stringify({ type: "sessions", sessions: await this.list() });
      this.sockets = this.sockets.filter((ws) => {
        try { ws.send(msg); return true; } catch { return false; }
      });
    }, 150);
  }
}
