import { useMemo, useState } from "react";
import type { Block, ChatModel } from "@boxen/client";
import { cn } from "@/lib/utils";

// The session as a DAG minimap: one row per event in transcript order, in
// three lanes (session, files, git), linked only by what was recorded. The
// cell's app.fs and app.git entries name the call whose probe saw each
// change, git's blob ids tie a version seen in the working tree to the
// commit that holds it, and the transcript's own order is the only other
// link. Hover or select a row: its parents light up solid, its children
// dashed, and the rest fade.

type Lane = "session" | "files" | "git";
type Rule = "order" | "call" | "blob" | "parent";
const RULES: Record<Rule, [string, string]> = {
  order: ["Transcript order", "The next entry in the transcript. Order, not causation."],
  call: ["Recorded by the cell", "The workspace probe after this call saw the change."],
  blob: ["Recorded by git", "The commit's tree holds this exact blob id at this path."],
  parent: ["Parent commit", "Named as a parent in the commit."],
};
const LANE: Record<Lane, string> = { session: "var(--foreground)", files: "var(--terminal-green)", git: "var(--terminal-yellow)" };
const FADED = "var(--border)";

interface Node {
  id: number; lane: Lane; kind: string; title: string; sub: string; detail: string;
  isError?: boolean;
  call?: string | null; // the tool call whose probe recorded this (files, git)
  toolId?: string | null; // a tool node's own call id
  path?: string; blob?: string | null; sha?: string; parents?: string[];
}
interface Edge { from: number; to: number; rule: Rule }

const firstLine = (s: string) => s.trim().split("\n").find((l) => l.trim()) ?? "";
const short = (sha: string | null | undefined) => (sha ?? "").slice(0, 7);
const preview = (b: Extract<Block, { kind: "tool" }>) => {
  const args = (b.args ?? {}) as Record<string, unknown>;
  const first = args.command ?? args.path ?? args.file_path ?? args.title;
  return typeof first === "string" ? firstLine(first) : "";
};
const FILE_KIND: Record<string, string> = { "??": "created", A: "created", D: "deleted", "": "reverted" };

// Nodes in transcript order and the edges the records admit.
function buildGraph(model: ChatModel): { nodes: Node[]; edges: Edge[] } {
  const rows: { seq: number; order: number; node: Omit<Node, "id"> }[] = [];
  let order = 0;
  const row = (seq: number, node: Omit<Node, "id">) => rows.push({ seq, order: order++, node });
  for (const item of model.items) {
    if (item.kind === "user") row(item.seq, { lane: "session", kind: "user", title: firstLine(item.text), sub: "prompt", detail: item.text });
    else if (item.kind === "system") row(item.seq, { lane: "session", kind: "note", title: item.text, sub: item.level, detail: item.text, isError: item.level === "error" });
    else for (const b of item.blocks) {
      if (b.kind === "text" && b.text.trim()) row(item.seq, { lane: "session", kind: "assistant", title: firstLine(b.text), sub: "assistant", detail: b.text });
      else if (b.kind === "tool") row(item.seq, {
        lane: "session", kind: "tool", toolId: b.toolId, title: preview(b) || b.name, sub: b.name, isError: b.isError,
        detail: `${JSON.stringify(b.args ?? {}, null, 1)}\n\n${b.state === "done" ? b.output : `(${b.state})`}`,
      });
    }
  }
  for (const e of model.timeline) {
    if (e.kind === "fs") {
      for (const f of e.files) row(e.seq, { lane: "files", kind: FILE_KIND[f.status] ?? "modified", title: f.path, sub: f.blob ? `blob ${short(f.blob)}` : (FILE_KIND[f.status] ?? f.status), detail: `${f.path}\nstatus ${f.status || "clean"}\nblob ${f.blob ?? "none"}`, call: e.call, path: f.path, blob: f.blob });
      if (e.truncated) row(e.seq, { lane: "files", kind: "note", title: "more paths changed than recorded", sub: "truncated", detail: "", call: e.call });
    } else {
      for (const c of e.commits) row(e.seq, {
        lane: "git", kind: "commit", title: c.subject, sub: `${short(c.sha)} · ${c.files.length} ${c.files.length === 1 ? "file" : "files"}`, call: e.call, sha: c.sha, parents: c.parents,
        detail: `${c.sha}\n${c.author} · ${new Date(c.time).toISOString()}\n\n${c.files.map((f) => `${f.status}  ${f.path}  ${short(f.blob)}`).join("\n")}`,
      });
      if (!e.commits.length) row(e.seq, { lane: "git", kind: "head", title: `${e.branch ?? "detached"} at ${short(e.head) || "no commit"}`, sub: "HEAD", detail: `HEAD ${e.head ?? "unborn"}\n${e.branch ?? ""}`, call: e.call });
    }
  }
  rows.sort((a, b) => a.seq - b.seq || a.order - b.order);
  const nodes = rows.map((r, i) => ({ id: i, ...r.node }));
  const edges: Edge[] = [];
  const link = (a: number, b: number, rule: Rule) => { if (a !== b) edges.push({ from: Math.min(a, b), to: Math.max(a, b), rule }); };
  const session = nodes.filter((n) => n.lane === "session");
  for (let i = 1; i < session.length; i++) link(session[i - 1].id, session[i].id, "order");
  const calls = new Map(nodes.filter((n) => n.toolId).map((n) => [n.toolId!, n.id]));
  for (const n of nodes) if (n.call && calls.has(n.call)) link(calls.get(n.call)!, n.id, "call");
  const commits = new Map(nodes.filter((n) => n.sha).map((n) => [n.sha!, n]));
  for (const c of commits.values()) {
    for (const p of c.parents ?? []) if (commits.has(p)) link(commits.get(p)!.id, c.id, "parent");
    const commit = model.timeline.flatMap((e) => (e.kind === "git" ? e.commits : [])).find((x) => x.sha === c.sha);
    for (const f of commit?.files ?? []) {
      const seen = nodes.filter((n) => n.lane === "files" && n.id < c.id && n.path === f.path && n.blob === f.blob).at(-1);
      if (seen) link(seen.id, c.id, "blob");
    }
  }
  return { nodes, edges };
}

// Grid layout in the manner of d3-dag's grid operator: a node takes the
// leftmost column whose stretch from its earliest parent's row down to its
// own row is free, and keeps that column down to its first child so chains
// run straight. ponytail: greedy, no crossing minimisation.
function layout(n: number, edges: Edge[]) {
  const parents: number[][] = Array.from({ length: n }, () => []), kids: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) { parents[e.to].push(e.from); kids[e.from].push(e.to); }
  const cols: { n: number; lo: number; hi: number }[][] = [];
  const col: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = parents[i].length ? Math.min(...parents[i]) : i, hi = kids[i].length ? Math.min(...kids[i]) : i;
    let c = 0;
    while ((cols[c] ?? []).some((o) => { const p = parents[i].includes(o.n); return Math.max(p ? o.n : o.lo, lo) < Math.min(p ? o.n : o.hi, i); })) c++;
    (cols[c] ??= []).push({ n: i, lo, hi });
    col[i] = c;
  }
  return { col, width: cols.length };
}

const H = 28, XS = 14, PAD = 10;

function glyph(n: Node, cx: number, cy: number) {
  if (n.kind === "user") return <rect x={cx - 4.5} y={cy - 4.5} width={9} height={9} fill="currentColor" />;
  if (n.kind === "tool") return <rect x={cx - 3.5} y={cy - 3.5} width={7} height={7} fill="var(--background)" stroke="currentColor" strokeWidth={1.5} />;
  if (n.kind === "commit") return <path d={`M${cx},${cy - 5.5}L${cx + 5.5},${cy}L${cx},${cy + 5.5}L${cx - 5.5},${cy}Z`} fill="currentColor" />;
  if (n.kind === "head") return <path d={`M${cx},${cy - 4.5}L${cx + 4.5},${cy}L${cx},${cy + 4.5}L${cx - 4.5},${cy}Z`} fill="var(--background)" stroke="currentColor" strokeWidth={1.5} />;
  if (n.lane === "files") return <circle cx={cx} cy={cy} r={3.5} fill={n.kind === "deleted" || n.kind === "reverted" ? "var(--background)" : "currentColor"} stroke="currentColor" strokeWidth={1.5} />;
  return <circle cx={cx} cy={cy} r={n.kind === "note" ? 2.5 : 3.5} fill="currentColor" />;
}

export function TimelineTab({ model }: { model: ChatModel }) {
  const [order, setOrder] = useState(true);
  const [sel, setSel] = useState<number | null>(null);
  const [hov, setHov] = useState<number | null>(null);
  const graph = useMemo(() => buildGraph(model), [model]);
  const edges = useMemo(() => graph.edges.filter((e) => order || e.rule !== "order"), [graph, order]);
  const { col, width } = useMemo(() => layout(graph.nodes.length, edges), [graph, edges]);
  const { nodes } = graph;
  const gw = PAD * 2 + Math.max(1, width) * XS;
  const x = (i: number) => PAD + col[i] * XS;
  const y = (i: number) => i * H + H / 2;
  const focus = hov ?? (sel != null && sel < nodes.length ? sel : null);
  const lit = new Set<number>();
  const parentEdges = new Set<number>(), childEdges = new Set<number>();
  if (focus != null) {
    lit.add(focus);
    edges.forEach((e, i) => {
      if (e.to === focus) { parentEdges.add(i); lit.add(e.from); }
      if (e.from === focus) { childEdges.add(i); lit.add(e.to); }
    });
  }
  const route = (e: Edge) => {
    const ax = x(e.from), bx = x(e.to), ay = y(e.from), by = y(e.to);
    if (ax === bx) return `M${ax},${ay}V${by}`;
    const r = Math.min(6, Math.abs(bx - ax) / 2, (by - ay) / 2), s = Math.sign(bx - ax);
    return `M${ax},${ay}H${bx - s * r}Q${bx},${ay} ${bx},${ay + r}V${by}`;
  };
  const edgeEl = (e: Edge, i: number) => {
    const p = parentEdges.has(i), c = childEdges.has(i);
    return (
      <path key={i} d={route(e)} fill="none" stroke="currentColor"
        strokeWidth={p ? 3 : c ? 2 : 1.25} strokeDasharray={c ? "5 2" : undefined}
        opacity={p || c ? 1 : hov != null ? 1 : e.rule === "order" ? 0.25 : 0.5}
        style={{ color: p || c || hov == null ? LANE[nodes[e.from].lane] : FADED }} />
    );
  };
  const selected = sel != null && sel < nodes.length ? nodes[sel] : null;
  const links = selected ? edges.map((e, i) => ({ e, i })).filter(({ e }) => e.from === selected.id || e.to === selected.id) : [];
  const counts = (["session", "files", "git"] as Lane[]).map((l) => [l, nodes.filter((n) => n.lane === l).length] as const);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-xs">
        <span className="flex min-w-0 flex-1 gap-3 truncate">
          {counts.map(([lane, n]) => (
            <span key={lane} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="inline-block size-2 rounded-full" style={{ background: LANE[lane] }} />{lane} <span className="tabular-nums">{n}</span>
            </span>
          ))}
        </span>
        <label className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={order} onChange={(e) => setOrder(e.target.checked)} />
          order
        </label>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto" onMouseLeave={() => setHov(null)}>
        {!nodes.length && <p className="px-3 py-8 text-center text-xs text-muted-foreground">Nothing in the transcript yet.</p>}
        <div className="relative" style={{ height: nodes.length * H }}>
          {nodes.map((n) => (
            <button key={n.id} type="button" onMouseEnter={() => setHov(n.id)} onClick={() => setSel(n.id)}
              className={cn("grid h-7 w-full items-center gap-2 border-b border-border/50 text-left text-xs hover:bg-muted", sel === n.id && "bg-muted", focus != null && lit.has(n.id) && "font-semibold")}
              style={{ gridTemplateColumns: `${gw}px minmax(0, 1fr) minmax(0, 34%)` }}>
              <span />
              <span className={cn("truncate", n.isError && "text-destructive")}>{n.title}</span>
              <span className="truncate pr-3 text-right font-mono text-[10px] text-muted-foreground">{n.sub}</span>
            </button>
          ))}
          <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={gw} height={nodes.length * H} aria-hidden="true">
            {edges.map((e, i) => (parentEdges.has(i) || childEdges.has(i) ? null : edgeEl(e, i)))}
            {edges.map((e, i) => (parentEdges.has(i) || childEdges.has(i) ? edgeEl(e, i) : null))}
            {nodes.map((n) => (
              <g key={n.id} style={{ color: focus == null || lit.has(n.id) || hov == null ? (n.isError ? "var(--destructive)" : LANE[n.lane]) : FADED }}>
                {sel === n.id && <circle cx={x(n.id)} cy={y(n.id)} r={8.5} fill="none" stroke="currentColor" strokeWidth={1.5} />}
                {glyph(n, x(n.id), y(n.id))}
              </g>
            ))}
          </svg>
        </div>
      </div>
      {selected && (
        <div className="max-h-48 shrink-0 overflow-auto border-t border-border px-3 py-2 text-xs">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 text-[10px] font-semibold tracking-wider uppercase" style={{ color: LANE[selected.lane] }}>{selected.lane} · {selected.kind}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{selected.title}</span>
            <button type="button" onClick={() => setSel(null)} className="shrink-0 text-muted-foreground hover:text-foreground">close</button>
          </div>
          {links.length ? links.map(({ e, i }) => {
            const other = nodes[e.from === selected.id ? e.to : e.from];
            return (
              <div key={i} className="mt-1.5 flex items-baseline gap-2">
                <span className="shrink-0 text-[10px] tracking-wider text-muted-foreground uppercase">{RULES[e.rule][0]}</span>
                <button type="button" onClick={() => setSel(other.id)} className="min-w-0 flex-1 truncate text-left hover:underline" style={{ color: LANE[other.lane] }} title={RULES[e.rule][1]}>
                  {e.from === selected.id ? "→" : "←"} {other.title}
                </button>
              </div>
            );
          }) : <p className="mt-1.5 text-muted-foreground">No recorded link. Nothing is drawn on proximity alone.</p>}
          {selected.detail && <pre className="mt-2 max-h-28 overflow-auto font-mono text-[11px] whitespace-pre-wrap break-all text-muted-foreground">{selected.detail.slice(0, 4000)}</pre>}
        </div>
      )}
    </div>
  );
}
