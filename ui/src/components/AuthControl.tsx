import { useState } from "react";
import { ArrowSquareOutIcon, SignOutIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { finishLogin, logout, startLogin, type AuthStatus } from "@/lib/api";

const PROVIDER = "openai";

// The fleet's own ChatGPT sign-in, separate from any pi login on the host.
// The Directory cell runs the OAuth flow; nothing listens on the redirect
// address, so the browser lands on a dead 127.0.0.1:1455 page whose address
// carries the code — pasting it back finishes the sign-in.
export function AuthControl({ auth }: { auth: AuthStatus | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signedIn = auth?.providers.includes(PROVIDER);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (signedIn && !url) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs">
        <span className="size-2 shrink-0 rounded-full bg-green-500" />
        <span className="min-w-0 flex-1 truncate">ChatGPT signed in</span>
        <Button variant="ghost" size="icon-sm" aria-label="Sign out" disabled={busy}
          onClick={() => run(async () => { await logout(PROVIDER); })}>
          <SignOutIcon className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border p-3 text-xs">
      {!url ? (
        <Button size="sm" className="w-full" disabled={busy}
          onClick={() => run(async () => {
            const step = await startLogin(PROVIDER, (end) => {
              if (end.error) setError(end.error);
              setUrl(null);
              setPasted("");
            });
            if (step.error) throw new Error(step.error);
            if (step.url) setUrl(step.url);
          })}>
          Sign in with ChatGPT
        </Button>
      ) : (
        <>
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 font-medium underline underline-offset-2">
            1. Open the ChatGPT sign-in <ArrowSquareOutIcon className="size-3.5" />
          </a>
          <p className="text-muted-foreground">
            2. After signing in, the tab lands on a page that won't load (127.0.0.1:1455). Copy that page's address and paste it here.
          </p>
          <Textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3}
            placeholder="http://127.0.0.1:1455/auth/callback?code=…" className="font-mono text-xs" />
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" disabled={busy || !pasted.trim()}
              onClick={() => run(async () => { await finishLogin(pasted.trim()); })}>
              {busy ? "Finishing…" : "Finish sign-in"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setUrl(null); setPasted(""); }}>Cancel</Button>
          </div>
        </>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
