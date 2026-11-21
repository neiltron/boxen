import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { reconnecting, system, webSocketTransport, type Issue, type Session, type SessionClient } from "@boxen/client";
import {
  ago, currentStep, defaultBrief, firstPrompt, foldersOf, issueKey, itemLabel, lastWord, laneOf, marksOf, matchesKind, sessionFor, sessionOptions,
  touchedFolders, type Folder, type Kind, type Lane, type Mark,
} from "./inbox.ts";

// Same origin: vite proxies /api, REST and WebSockets, to the boxen node.
const boxen = system(location.origin, { transport: webSocketTransport });
const HOUR = 60 * 60 * 1000;

type Item = { key: string; repo: string; issue: Issue; session?: Session; lane: Lane };

// The repos and label to read, kept in the address so a reload or a bookmark keeps them.
function readConfig() {
  const q = new URLSearchParams(location.search);
  const kind: Kind = q.get("kind") === "prs" ? "prs" : q.get("kind") === "issues" ? "issues" : "all";
  return { kind, repos: (q.get("repos") ?? "").split(",").map((r) => r.trim()).filter(Boolean), label: q.get("label") ?? "" };
}

// The Directory's live session list: the same feed boxen's own sidebar reads.
function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => {
    const ws = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/directory/ws`;
    const socket = reconnecting<{ type: string; sessions?: Session[] }>(ws, {
      message: (m) => { if (m.type === "sessions" && m.sessions) setSessions(m.sessions); },
    }, { transport: webSocketTransport });
    return () => socket.close();
  }, []);
  return sessions;
}

// One live session client per linked Session, re-rendering at most once a frame.
function useSessionClients(ids: string[]) {
  const pool = useRef(new Map<string, { client: SessionClient; stop: () => void }>());
  const [, force] = useReducer((n: number) => n + 1, 0);
  const frame = useRef(0);
  const key = ids.join(",");
  useEffect(() => {
    const bump = () => { if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; force(); }); };
    for (const id of ids) {
      if (pool.current.has(id)) continue;
      const client = boxen.session(id);
      const unsubscribe = client.subscribe(bump);
      const disconnect = client.connect();
      pool.current.set(id, { client, stop: () => { unsubscribe(); disconnect(); } });
    }
    for (const [id, entry] of pool.current) if (!ids.includes(id)) { entry.stop(); pool.current.delete(id); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => { for (const entry of pool.current.values()) entry.stop(); pool.current.clear(); }, []);
  return pool.current;
}

function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function App() {
  const [config, setConfig] = useState(readConfig);
  const [issues, setIssues] = useState<{ repo: string; issue: Issue }[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => decodeURIComponent(location.hash.slice(1)) || null);
  const [files, setFiles] = useState<Record<string, Folder[]>>({});
  const sessions = useSessions();
  const now = useNow();

  // Issues: on load, on a config change, and whenever the window comes back into focus.
  useEffect(() => {
    let live = true;
    const load = async () => {
      setLoading(true);
      const results = await Promise.allSettled(config.repos.map(async (repo) =>
        (await boxen.api.listIssues(repo, config.label || undefined)).map((issue) => ({ repo, issue }))));
      if (!live) return;
      setIssues(results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
      setErrors(results.flatMap((r, i) => (r.status === "rejected" ? [`${config.repos[i]}: ${(r.reason as Error).message}`] : [])));
      setLoading(false);
    };
    void load();
    window.addEventListener("focus", load);
    return () => { live = false; window.removeEventListener("focus", load); };
  }, [config.repos, config.label]);

  useEffect(() => { history.replaceState(null, "", selected ? `#${encodeURIComponent(selected)}` : location.pathname + location.search); }, [selected]);

  const items = useMemo(() => issues.filter(({ issue }) => matchesKind(issue, config.kind)).map(({ repo, issue }): Item => {
    const session = sessionFor(repo, issue.number, sessions);
    return { key: issueKey(repo, issue.number), repo, issue, session, lane: laneOf(session) };
  }), [issues, sessions, config.kind]);
  const clients = useSessionClients(items.flatMap((i) => (i.session ? [i.session.id] : [])));

  const lanes: { lane: Lane; label: string; items: Item[] }[] = [
    { lane: "waiting", label: "Needs you", items: [] },
    { lane: "running", label: "Running", items: [] },
    { lane: "todo", label: "To do", items: [] },
  ];
  for (const item of items) lanes.find((l) => l.lane === item.lane)!.items.push(item);
  for (const l of lanes) if (l.lane !== "todo") l.items.sort((a, b) => (b.session?.lastActivity ?? 0) - (a.session?.lastActivity ?? 0));

  const current = items.find((i) => i.key === selected);
  const showRepo = config.repos.length > 1;

  // The repo's shape, read once per repo when one of its issues opens.
  useEffect(() => {
    const repo = current?.repo;
    if (!repo || files[repo]) return;
    boxen.api.listRepoFiles(repo).then((r) => setFiles((f) => ({ ...f, [repo]: foldersOf(r.paths) })), () => setFiles((f) => ({ ...f, [repo]: [] })));
  }, [current?.repo, files]);

  const view = (item: Item) => {
    const client = item.session ? clients.get(item.session.id) : undefined;
    const marks = client ? marksOf(client.client.state().model.log) : [];
    const waitingSince = item.lane === "waiting" ? item.session?.lastActivity ?? null : null;
    const word = client && item.lane === "waiting" ? lastWord(client.client.state().model) : null;
    const meta =
      item.lane === "todo" ? `Opened ${ago(now - Date.parse(item.issue.createdAt))}` :
      item.lane === "running" ? "Running" :
      `${word?.error ? "Failed" : "Waiting"} · ${ago(now - (waitingSince ?? now))}`;
    return { client: client?.client, marks, waitingSince, meta, failed: !!word?.error };
  };

  return (
    <div className="app">
      <Header config={config} loading={loading} onApply={(next) => {
        const q = new URLSearchParams();
        if (next.repos.length) q.set("repos", next.repos.join(","));
        if (next.label) q.set("label", next.label);
        if (next.kind !== "all") q.set("kind", next.kind);
        history.replaceState(null, "", `?${q}${location.hash}`);
        setConfig(next);
      }} />
      {errors.map((e) => <p key={e} className="banner">{e}</p>)}
      {!config.repos.length ? (
        <main className="empty"><p>Add a repo above, as <code>owner/name</code>, to see its open issues and same-repo PRs.</p></main>
      ) : !current ? (
        <main className="list">
          <div className="list-inner">
            <div className="axis"><span>1 hour ago</span><span>now</span></div>
            {lanes.filter((l) => l.items.length).map((l) => (
              <section key={l.lane}>
                <h2 className="lane">{l.label} · {l.items.length}</h2>
                {l.items.map((item) => {
                  const v = view(item);
                  return (
                    <button key={item.key} className="row" onClick={() => setSelected(item.key)}>
                      <Indicator issue={item.issue} />
                      <span className="num">#{item.issue.number}</span>
                      <span className="row-text">
                        <span className="title">{item.issue.title}</span>
                        <span className={`meta ${item.lane === "waiting" ? "warn" : ""}`}>{showRepo ? `${item.repo} · ` : ""}{v.meta}</span>
                      </span>
                      <Strip marks={v.marks} waitingSince={v.waitingSince} now={now} className={`strip-row ${item.session ? "" : "none"}`} />
                    </button>
                  );
                })}
              </section>
            ))}
            {!items.length && !loading && <p className="quiet">No open {config.kind === "prs" ? "same-repo PRs" : config.kind === "issues" ? "issues" : "issues or same-repo PRs"}{config.label ? ` labelled ${config.label}` : ""}.</p>}
            <Legend />
          </div>
        </main>
      ) : (
        <div className="split">
          <nav className="side" aria-label="Issues and pull requests">
            {lanes.filter((l) => l.items.length).map((l) => (
              <section key={l.lane}>
                <h2 className="lane">{l.label} · {l.items.length}</h2>
                {l.items.map((item) => {
                  const v = view(item);
                  return (
                    <button key={item.key} className="side-row" aria-current={item.key === selected} onClick={() => setSelected(item.key)}>
                      <span className="title"><Indicator issue={item.issue} /> {item.issue.title}</span>
                      <span className="side-meta">
                        <span className={`meta ${item.lane === "waiting" ? "warn" : ""}`}>#{item.issue.number} · {v.meta}</span>
                        <Strip marks={v.marks} waitingSince={v.waitingSince} now={now} className={`strip-side ${item.session ? "" : "none"}`} />
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}
          </nav>
          <Detail key={current.key} item={current} {...view(current)} now={now} folders={files[current.repo]} onClose={() => setSelected(null)} />
        </div>
      )}
    </div>
  );
}

function Header({ config, loading, onApply }: { config: ReturnType<typeof readConfig>; loading: boolean; onApply(c: ReturnType<typeof readConfig>): void }) {
  const [repos, setRepos] = useState(config.repos.join(", "));
  const [label, setLabel] = useState(config.label);
  return (
    <header className="bar">
      <span className="brand">Inbox</span>
      <form className="filters" onSubmit={(e) => {
        e.preventDefault();
        onApply({ kind: config.kind, repos: repos.split(",").map((r) => r.trim()).filter(Boolean), label: label.trim() });
      }}>
        <label>
          <span className="sr">Repos</span>
          <input value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="owner/name, owner/name" spellCheck={false} />
        </label>
        <label>
          <span className="sr">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="any label" spellCheck={false} className="label-input" />
        </label>
        <label>
          <span className="sr">Item type</span>
          <select className="ghost" value={config.kind} onChange={(e) => onApply({ ...config, kind: e.target.value as Kind })}>
            <option value="all">All</option>
            <option value="issues">Issues</option>
            <option value="prs">PRs</option>
          </select>
        </label>
        <button type="submit" className="ghost">{loading ? "Loading…" : "Show"}</button>
      </form>
    </header>
  );
}

function Indicator({ issue }: { issue: Issue }) {
  return <span className={`item-kind ${issue.pullRequest && !issue.pullRequest.draft ? "review-ready" : ""}`} title={itemLabel(issue)} aria-label={itemLabel(issue)}>
    {issue.pullRequest ? issue.pullRequest.draft ? "Draft PR" : "PR" : "Issue"}
  </span>;
}

function Strip({ marks, waitingSince, now, className }: { marks: Mark[]; waitingSince: number | null; now: number; className: string }) {
  const pos = (t: number) => `${Math.max(0, Math.min(100, 100 - ((now - t) / HOUR) * 100))}%`;
  const recent = marks.filter((m) => now - m.at <= HOUR);
  const yours = recent.filter((m) => m.kind === "you").length;
  const label = marks.length || waitingSince
    ? `In the last hour: ${yours} messages from you, ${recent.length - yours} tool calls${waitingSince ? ", now waiting on you" : ""}`
    : "No session yet";
  return (
    <span className={`strip ${className}`} role="img" aria-label={label}>
      {recent.map((m, i) => <span key={i} className={`tick ${m.kind}`} style={{ left: pos(m.at) }} />)}
      {waitingSince !== null && <span className="wait" style={{ left: pos(Math.max(waitingSince, now - HOUR)) }} />}
    </span>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span><span className="key you" />your message</span>
      <span><span className="key tool" />tool call</span>
      <span><span className="key wait" />waiting on you since</span>
    </div>
  );
}

type DetailProps = {
  item: Item; client?: SessionClient; marks: Mark[]; waitingSince: number | null; meta: string; failed: boolean;
  now: number; folders?: Folder[]; onClose(): void;
};

function Detail({ item, client, marks, waitingSince, meta, failed, now, folders, onClose }: DetailProps) {
  const { issue, repo, session, lane } = item;
  const [brief, setBrief] = useState(() => defaultBrief(issue));
  const [scope, setScope] = useState<string[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = client?.state().model;
  const ready = !!client?.state().ready;
  const cwd = session?.cwd ?? "";
  const touched = model && folders ? touchedFolders(model, cwd, folders) : {};
  const word = model ? lastWord(model) : null;
  const step = model && lane === "running" ? currentStep(model, cwd) : null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await boxen.api.createSession(sessionOptions(repo, issue));
      // Its own connection for the first turn; the list picks the Session up from the Directory.
      // ponytail: a tab closed before the socket joins leaves the Session without its first message.
      const first = boxen.session(created.id);
      const disconnect = first.connect();
      void first.run(firstPrompt({ repo, issue, brief, scope })).finally(disconnect);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    if (!client || !reply.trim()) return;
    if (client.prompt(reply.trim())) setReply("");
    else setError("Not connected to the session yet. Try again in a moment.");
  };

  return (
    <main className="detail">
      <div className="detail-inner">
        <div className="detail-top">
          <button className="back" onClick={onClose}>‹ Inbox</button>
          <span className={`meta ${lane === "waiting" ? "warn" : ""}`}>{meta}</span>
          <button className="icon" onClick={onClose} aria-label="Close panel">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 2l10 10M12 2L2 12" /></svg>
          </button>
        </div>

        <header className="issue-head">
          <h1>{issue.title}</h1>
          <p className="meta">
            <Indicator issue={issue} /> <span className="mono">#{issue.number}</span> · {repo} · opened {ago(now - Date.parse(issue.createdAt))}
            {issue.author ? ` by ${issue.author}` : ""}{issue.labels.length ? ` · ${issue.labels.join(", ")}` : ""} · <a href={issue.url} target="_blank" rel="noreferrer">GitHub ↗</a>
          </p>
        </header>

        {issue.body.trim() && <p className="body">{issue.body.trim()}</p>}

        {session && (
          <section className="block">
            <div className="block-head"><h2>Last hour</h2><span>now</span></div>
            <Strip marks={marks} waitingSince={waitingSince} now={now} className="strip-big" />
            <p className="meta">
              {step ? `Now: ${step}` : lane === "running" ? "Working" : waitingSince ? `Stopped ${ago(now - waitingSince)}` : ""}
              {" · "}in boxen as “{session.name}”
            </p>
          </section>
        )}

        <section className="block">
          <div className="block-head">
            <h2>{lane === "todo" ? "Scope" : "Where it worked"}</h2>
            <span>{lane === "todo" ? "Pick folders to keep the agent inside them" : Object.keys(touched).length ? "Shaded by edits" : "No edits yet"}</span>
          </div>
          {!folders ? <p className="quiet">Reading the repo…</p> : !folders.length ? <p className="quiet">Couldn't read the repo's files.</p> : (
            <div className="map">
              {folders.map((f) => {
                const edits = touched[f.name] ?? 0;
                const pinned = scope.includes(f.name);
                const style = { flex: `${Math.sqrt(f.files)} 1 ${Math.round(Math.sqrt(f.files) * 40)}px` };
                const shade = edits > 6 ? "s3" : edits > 2 ? "s2" : edits > 0 ? "s1" : "";
                return lane === "todo" ? (
                  <button key={f.name} className={`cell ${pinned ? "pinned" : ""}`} style={style} aria-pressed={pinned}
                    onClick={() => setScope((s) => (pinned ? s.filter((n) => n !== f.name) : [...s, f.name]))}>
                    <span className="mono">{f.name}</span>
                    <span className="cell-note">{pinned ? "in scope" : `${f.files} file${f.files === 1 ? "" : "s"}`}</span>
                  </button>
                ) : (
                  <div key={f.name} className={`cell ${shade}`} style={style}>
                    <span className="mono">{f.name}</span>
                    <span className="cell-note">{edits ? `${edits} edit${edits > 1 ? "s" : ""}` : ""}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {lane === "todo" ? (
          <section className="block action">
            <label htmlFor="brief">Brief for the agent</label>
            <textarea id="brief" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} />
            <div className="action-row">
              <span className="meta">{scope.length ? `Stays inside ${scope.join(", ")}` : "No scope set"} · {issue.pullRequest ? "PR description" : "issue text"} attached</span>
              <button className="primary" onClick={start} disabled={busy}>{busy ? "Starting…" : issue.pullRequest ? "Start review" : "Start session"}</button>
            </div>
          </section>
        ) : (
          <section className="block action">
            {lane === "waiting" && word && (
              <>
                <h2>{failed ? "The turn failed" : "The agent says"}</h2>
                {failed ? <p className="said failed">{word.text}</p> : (
                  // react-markdown builds a React tree (no innerHTML), so agent output can't inject markup.
                  <div className="said md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>
                      {word.text}
                    </ReactMarkdown>
                  </div>
                )}
              </>
            )}
            <label htmlFor="reply">{lane === "running" ? "Steer" : "Reply"}</label>
            <textarea id="reply" rows={3} value={reply} onChange={(e) => setReply(e.target.value)}
              placeholder={lane === "running" ? "Redirect it while it works" : "Answer, or tell it what to do next"}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
            <div className="action-row">
              <span className="meta">{ready ? "⌘↵ to send" : "Connecting…"}</span>
              <span className="buttons">
                {lane === "running" && <button className="secondary" onClick={() => client?.abort()} disabled={!ready}>Stop turn</button>}
                <button className="primary" onClick={send} disabled={!ready || !reply.trim()}>Send</button>
              </span>
            </div>
          </section>
        )}
        {error && <p className="banner">{error}</p>}
      </div>
    </main>
  );
}
