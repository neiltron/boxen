import { useEffect, useId, useState } from "react";
import { ArrowClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { fetchListeningPorts, PREVIEW_PORTS, validPreviewPort } from "@/lib/api";

function validPort(value: string) {
  return /^\d+$/.test(value) && validPreviewPort(Number(value));
}

function savedPort(sessionId: string) {
  try {
    const saved = localStorage.getItem(`pids.previewPort.${sessionId}`);
    if (saved && validPort(saved)) return saved;
  } catch { /* storage may be disabled */ }
  return "5173";
}

// Keyed by session in Panel so switching sessions never carries an iframe or
// an in-flight ports lookup into the next session.
export function PreviewTab({ sessionId }: { sessionId: string }) {
  const [port, setPort] = useState(() => savedPort(sessionId));
  const [input, setInput] = useState(port);
  const [nonce, setNonce] = useState(0);
  const [ports, setPorts] = useState<number[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const fieldId = useId();
  const valid = validPort(input);
  // The UI is on :5176; preview traffic goes straight to celld, not Vite.
  const url = `http://p${port}-${sessionId}.localhost:8093/`;

  function show(value: string) {
    if (!validPort(value)) return;
    const next = String(Number(value));
    setPort(next);
    setInput(next);
    setNonce((n) => n + 1);
    try { localStorage.setItem(`pids.previewPort.${sessionId}`, next); } catch { /* not persisted */ }
    void scan();
  }

  async function scan() {
    setScanning(true);
    setError("");
    try { setPorts((await fetchListeningPorts(sessionId)).ports); }
    catch (e) { setError((e as Error).message); }
    finally { setScanning(false); }
  }

  // Scan on open. The iframe loads only a port that's listening: a request to
  // a quiet port makes the SDK wait 90s and mark the container's state stale.
  useEffect(() => { void scan(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const live = ports?.includes(Number(port)) ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={(event) => { event.preventDefault(); show(input); }}
        className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <label htmlFor={fieldId} className="text-muted-foreground">Port</label>
        <input id={fieldId} type="text" inputMode="numeric" value={input}
          onChange={(event) => setInput(event.target.value)} aria-invalid={!valid}
          aria-describedby={!valid ? `${fieldId}-error` : undefined}
          className="w-20 rounded-md border border-border bg-background px-2 py-1 font-mono outline-none focus:border-ring" />
        <button type="submit" disabled={!valid}
          className="rounded-md px-2 py-1 hover:bg-muted disabled:opacity-40">Go</button>
        <span className="flex-1" />
        <button type="button" aria-label="Reload preview" title="Reload preview" onClick={() => setNonce((n) => n + 1)}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowClockwiseIcon className="size-3.5" />
        </button>
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open preview in new tab" title="Open preview in new tab"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowSquareOutIcon className="size-3.5" />
        </a>
      </form>
      {!valid && <p id={`${fieldId}-error`} className="px-3 py-1 text-xs text-destructive">Use a port from {PREVIEW_PORTS.min}–{PREVIEW_PORTS.max}, except {PREVIEW_PORTS.reserved} (sandbox control server).</p>}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
        <button type="button" disabled={scanning} onClick={() => void scan()} className="hover:text-foreground disabled:opacity-40">
          {scanning ? "Checking…" : "Find listening ports"}
        </button>
        {ports?.map((p) => (
          <button key={p} type="button" onClick={() => show(String(p))} className="rounded bg-muted px-1.5 py-0.5 font-mono hover:text-foreground">{p}</button>
        ))}
        {ports?.length === 0 && <span>No app ports listening.</span>}
        {error && <span role="status" className="text-destructive">{error}</span>}
      </div>
      {live ? (
        <iframe key={`${url}:${nonce}`} src={url} title={`Session preview on port ${port}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
          className="min-h-0 w-full flex-1 border-0 bg-white" />
      ) : (
        <p className="px-3 py-8 text-center text-xs text-muted-foreground">
          {ports === null ? "Checking listening ports…" : `Nothing is listening on ${port}. Start the app on 0.0.0.0, then Find listening ports.`}
        </p>
      )}
    </div>
  );
}
