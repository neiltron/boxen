// Artifacts — singleton cell holding every session's artifacts: what the
// agent shows beside the chat (plans, explainers, visualizations, diagrams).
// They live here rather than in a sandbox, so they stay readable and
// searchable while sandboxes sleep. Every save keeps a version.
import { DurableObject } from "cloudflare:workers";

export const ARTIFACT_KINDS = ["markdown", "html", "svg", "mermaid", "code"];

export class Artifacts extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS artifacts(
      id TEXT PRIMARY KEY, session TEXT, title TEXT, kind TEXT, language TEXT,
      content TEXT, version INT, createdAt INT, updatedAt INT)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session, updatedAt)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS versions(
      id TEXT, version INT, title TEXT, content TEXT, ts INT, PRIMARY KEY(id, version))`);
    this.sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
      id UNINDEXED, title, content, tokenize = 'porter unicode61')`);
  }

  // Creates, or updates when `id` names an artifact of the same session.
  async save({ id, session, title, kind, language, content }) {
    const now = Date.now();
    const existing = id
      ? this.sql.exec(`SELECT version, session FROM artifacts WHERE id = ?`, id).toArray()[0]
      : undefined;
    if (existing && existing.session !== session) throw new Error(`artifact ${id} belongs to another session`);
    const version = (existing?.version ?? 0) + 1;
    const artifactId = existing ? id : crypto.randomUUID().slice(0, 8);
    this.sql.exec(
      `INSERT INTO artifacts(id, session, title, kind, language, content, version, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, kind = excluded.kind,
         language = excluded.language, content = excluded.content,
         version = excluded.version, updatedAt = excluded.updatedAt`,
      artifactId, session, title, kind, language ?? null, content, version, now, now,
    );
    this.sql.exec(`INSERT INTO versions VALUES (?,?,?,?,?)`, artifactId, version, title, content, now);
    this.sql.exec(`DELETE FROM artifacts_fts WHERE id = ?`, artifactId);
    this.sql.exec(`INSERT INTO artifacts_fts(id, title, content) VALUES (?,?,?)`, artifactId, title, content);
    return { id: artifactId, version };
  }

  async get(id, version) {
    const row = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    if (!row || !version || version === row.version) return row ?? null;
    const old = this.sql.exec(`SELECT title, content FROM versions WHERE id = ? AND version = ?`, id, version).toArray()[0];
    return old ? { ...row, ...old, version } : null;
  }

  async list(session) {
    const cols = `id, session, title, kind, language, version, createdAt, updatedAt`;
    return session
      ? this.sql.exec(`SELECT ${cols} FROM artifacts WHERE session = ? ORDER BY updatedAt DESC`, session).toArray()
      : this.sql.exec(`SELECT ${cols} FROM artifacts ORDER BY updatedAt DESC LIMIT 200`).toArray();
  }

  // Full-text search across every session, best match first.
  async search(query) {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(" ");
    return this.sql.exec(
      `SELECT a.id, a.session, a.title, a.kind, a.version, a.updatedAt,
         snippet(artifacts_fts, 2, '[', ']', '…', 12) AS snippet
       FROM artifacts_fts JOIN artifacts a ON a.id = artifacts_fts.id
       WHERE artifacts_fts MATCH ? ORDER BY rank LIMIT 50`,
      match,
    ).toArray();
  }
}
