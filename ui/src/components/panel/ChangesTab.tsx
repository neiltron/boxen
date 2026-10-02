import { useEffect, useMemo, useRef, useState } from "react";
import { FileDiff, parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { ArrowClockwiseIcon, CaretRightIcon } from "@phosphor-icons/react";
import { fetchDiff } from "@/lib/api";
import { cn } from "@/lib/utils";

// Pierre picks light/dark from `themeType`; follow the app's .dark class.
function useIsDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

// One file's diff with Pierre's vanilla renderer. Inside a Trellis view the
// first render can come out blank (Pierre's React FileDiff stayed empty
// until something re-rendered it), so draw again whenever the view's size
// changes: that covers the initial layout, panel resizes, and docking moves.
function Diff({ file, options }: { file: FileDiffMetadata; options: FileDiffOptions<undefined, undefined> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const container = host.appendChild(document.createElement("diffs-container"));
    const diff = new FileDiff(options);
    const draw = () => diff.render({ fileDiff: file, fileContainer: container, forceRender: true });
    const observer = new ResizeObserver(draw);
    observer.observe(host);
    return () => { observer.disconnect(); diff.cleanUp(); container.remove(); };
  }, [file, options]);
  return <div ref={ref} />;
}

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}

const count = (f: FileDiffMetadata) => f.hunks.reduce(
  (n, h) => ({ add: n.add + h.additionLines, del: n.del + h.deletionLines }), { add: 0, del: 0 });

const CHANGE_LABEL: Record<FileDiffMetadata["type"], string> = {
  change: "", new: "new", deleted: "deleted", "rename-pure": "renamed", "rename-changed": "renamed",
};

// The sandbox's working tree against HEAD (untracked files included),
// refetched after the agent edits or runs commands, and on demand.
export function ChangesTab({ sessionId, refresh }: { sessionId: string; refresh: number }) {
  const [state, setState] = useState<{ repo: boolean; patch: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [style, setStyle] = useState<"unified" | "split">(() => load("pids.diffStyle", "unified"));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const dark = useIsDark();

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      fetchDiff(sessionId).then(
        (r) => { if (live) { setState(r); setError(""); } },
        (e: Error) => { if (live) setError(e.message); },
      ).finally(() => { if (live) setLoading(false); });
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [sessionId, refresh, nonce]);

  const files = useMemo(
    () => (state?.patch ? parsePatchFiles(state.patch, sessionId).flatMap((p) => p.files) : []),
    [state?.patch, sessionId],
  );
  const totals = files.reduce((t, f) => { const c = count(f); return { add: t.add + c.add, del: t.del + c.del }; }, { add: 0, del: 0 });
  const options = useMemo(() => ({
    theme: { dark: "pierre-dark", light: "pierre-light" },
    themeType: dark ? "dark" : "light",
    diffStyle: style,
    overflow: "wrap",
    disableFileHeader: true, // our own sticky header row collapses the file
  } as const), [dark, style]);

  const toggle = (name: string) => setCollapsed((s) => {
    const next = new Set(s);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {files.length ? (
            <>
              {files.length} {files.length === 1 ? "file" : "files"}{" "}
              <span className="text-green-600 dark:text-green-400">+{totals.add}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{totals.del}</span>
            </>
          ) : "Changes"}
        </span>
        <div className="flex rounded-md border border-border p-0.5">
          {(["unified", "split"] as const).map((s) => (
            <button key={s} type="button"
              onClick={() => { setStyle(s); try { localStorage.setItem("pids.diffStyle", JSON.stringify(s)); } catch { /* not persisted */ } }}
              className={cn("rounded px-1.5 py-0.5", style === s ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {s}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Refresh changes" onClick={() => setNonce((n) => n + 1)}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowClockwiseIcon className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ "--diffs-font-family": "var(--font-jetbrains-mono)", "--diffs-font-size": "12px" } as React.CSSProperties}
      >
        {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
        {!error && state && !state.repo && (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">This session has no git repo, so there's nothing to diff.</p>
        )}
        {!error && state?.repo && !files.length && (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">No changes against HEAD.</p>
        )}
        {!state && !error && <p className="px-3 py-8 text-center text-xs text-muted-foreground">Loading…</p>}
        {files.map((f) => {
          const c = count(f);
          const shut = collapsed.has(f.name);
          return (
            <section key={f.name} className="border-b border-border">
              <button type="button" onClick={() => toggle(f.name)}
                className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-left text-xs hover:bg-muted">
                <CaretRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !shut && "rotate-90")} />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {f.prevName && f.prevName !== f.name ? `${f.prevName} → ${f.name}` : f.name}
                </span>
                {CHANGE_LABEL[f.type] && <span className="shrink-0 text-muted-foreground">{CHANGE_LABEL[f.type]}</span>}
                <span className="shrink-0 tabular-nums text-green-600 dark:text-green-400">+{c.add}</span>
                <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{c.del}</span>
              </button>
              {!shut && <Diff file={f} options={options} />}
            </section>
          );
        })}
      </div>
    </div>
  );
}
