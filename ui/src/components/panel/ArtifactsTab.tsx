import { useEffect, useState } from "react";
import { ArrowLeftIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { ArtifactView } from "@/components/panel/ArtifactView";
import { getArtifact, listArtifacts, searchArtifacts, type Artifact, type ArtifactSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

// This session's artifacts, or a search across every session's. Served by
// the Artifacts cell, so they open even while the sandbox sleeps.
export function ArtifactsTab({ sessionId, selected, onSelect, refresh }: {
  sessionId: string; selected: string | null; onSelect: (id: string | null) => void; refresh: number;
}) {
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ArtifactSummary[]>([]);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [version, setVersion] = useState<number | undefined>();
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const q = query.trim();
    const t = setTimeout(() => {
      (q ? searchArtifacts(q) : listArtifacts(sessionId)).then(
        (rows) => { if (live) { setList(rows); setError(""); } },
        (e: Error) => { if (live) setError(e.message); },
      );
    }, q ? 200 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [sessionId, query, refresh]);

  useEffect(() => { setVersion(undefined); }, [selected]);
  useEffect(() => {
    let live = true;
    if (!selected) { setArtifact(null); return; }
    getArtifact(selected, version).then(
      (a) => { if (live) setArtifact(a); },
      (e: Error) => { if (live) setError(e.message); },
    );
    return () => { live = false; };
  }, [selected, version, refresh]);

  if (selected && artifact) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
          <button type="button" onClick={() => onSelect(null)} aria-label="All artifacts"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <ArrowLeftIcon className="size-3.5" />
          </button>
          <span className="min-w-0 flex-1 truncate font-medium">{artifact.title}</span>
          <span className="text-muted-foreground">{artifact.kind}</span>
          <select
            value={artifact.version} onChange={(e) => setVersion(Number(e.target.value))}
            className="rounded border border-border bg-background px-1 py-0.5"
            aria-label="Version"
          >
            {Array.from({ length: Math.max(artifact.version, version ?? 0) }, (_, i) => i + 1).reverse().map((v) => (
              <option key={v} value={v}>v{v}</option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1"><ArtifactView artifact={artifact} /></div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <label className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <MagnifyingGlassIcon className="size-3.5 text-muted-foreground" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all artifacts…"
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
        {list.map((a) => (
          <button key={a.id} type="button" onClick={() => onSelect(a.id)}
            className="block w-full border-b border-border/50 px-3 py-2 text-left hover:bg-muted">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{a.kind} · v{a.version} · {ago(a.updatedAt)}</span>
            </span>
            {a.snippet && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{a.snippet}</span>}
            {query && a.session !== sessionId && <span className={cn("text-[11px] text-muted-foreground")}>other session</span>}
          </button>
        ))}
        {!error && list.length === 0 && (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            {query ? "No matches" : "Nothing yet. The agent's artifact tool puts plans, explainers, and diagrams here."}
          </p>
        )}
      </div>
    </div>
  );
}
