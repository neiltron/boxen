import { useEffect, useState } from "react";
import { ArrowSquareOutIcon, PlugsConnectedIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  finishLogin, listProviders, logout, setApiKey, startLogin,
  type AuthStatus, type ProviderInfo,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Pending = { provider: string; url: string; code?: string };

// Model providers this fleet can use: any pi-ai provider, by API key or by
// its own sign-in. Credentials live in the Directory cell, never copied
// from a pi login on the host.
export function ProvidersSheet({ auth }: { auth: AuthStatus | null }) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connectedCount = auth?.providers.length ?? 0;

  useEffect(() => {
    if (open) listProviders().then(setProviders, (e: Error) => setError(e.message));
  }, [open, auth]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const signIn = (p: ProviderInfo) => run(async () => {
    const step = await startLogin(p.id, (end) => {
      if (end.error) setError(end.error);
      setPending(null);
      setPasted("");
    });
    if (step.error) throw new Error(step.error);
    if (step.url) {
      setPending({ provider: p.id, url: step.url, code: step.code });
      window.open(step.url, "_blank", "noopener");
    }
  });

  const q = query.trim().toLowerCase();
  const shown = providers
    .filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q))
    .toSorted((a, b) => Number(!!b.connected) - Number(!!a.connected) || a.name.localeCompare(b.name));

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button type="button" className="flex w-full items-center gap-2 border-t border-border px-3 py-2.5 text-left text-xs hover:bg-muted">
          <PlugsConnectedIcon className="size-3.5 text-muted-foreground" />
          <span className="flex-1">Providers</span>
          <span className={cn("text-muted-foreground", !connectedCount && "text-destructive")}>
            {connectedCount ? `${connectedCount} connected` : "none connected"}
          </span>
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-[min(26rem,100vw)] flex-col gap-0 p-0 sm:max-w-none">
        <SheetHeader className="border-b border-border">
          <SheetTitle>Model providers</SheetTitle>
          <SheetDescription>Add an API key or sign in. Sessions use these from the cells; nothing is read from the host.</SheetDescription>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search providers…" className="mt-2" />
        </SheetHeader>
        {error && <p className="border-b border-border px-4 py-2 text-xs text-destructive">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {shown.map((p) => (
            <div key={p.id} className="border-b border-border/60">
              <button
                type="button"
                onClick={() => { setExpanded(expanded === p.id ? null : p.id); setKey(""); }}
                className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-muted"
              >
                <span className={cn("size-2 shrink-0 rounded-full", p.connected ? "bg-green-500" : "bg-muted-foreground/30")} />
                <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {p.connected === "oauth" ? "signed in" : p.connected === "api_key" ? "API key" : ""}
                </span>
              </button>
              {expanded === p.id && (
                <div className="space-y-2 px-4 pb-3 text-xs">
                  {p.oauth && pending?.provider !== p.id && (
                    <Button size="sm" variant="outline" className="w-full" disabled={busy} onClick={() => signIn(p)}>
                      {p.oauth.label} <span className="text-muted-foreground">· {p.oauth.name}</span>
                    </Button>
                  )}
                  {pending?.provider === p.id && (
                    <div className="space-y-2 rounded-md border border-border p-2">
                      <a href={pending.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 underline underline-offset-2">
                        Open the sign-in page <ArrowSquareOutIcon className="size-3.5" />
                      </a>
                      {pending.code && <p>Enter the code <span className="font-mono font-medium">{pending.code}</span> there.</p>}
                      <p className="text-muted-foreground">
                        This finishes by itself once you approve. If you're on another machine and the page lands on a localhost address that won't load, paste that address here:
                      </p>
                      <div className="flex gap-2">
                        <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost:…/callback?code=…" className="font-mono text-xs" />
                        <Button size="sm" disabled={busy || !pasted.trim()} onClick={() => run(async () => { await finishLogin(pasted.trim()); })}>Finish</Button>
                      </div>
                    </div>
                  )}
                  {p.apiKey && (
                    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await setApiKey(p.id, key.trim()); setKey(""); }); }}>
                      <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.apiKey.name} className="text-xs" />
                      <Button size="sm" type="submit" disabled={busy || !key.trim()}>Save</Button>
                    </form>
                  )}
                  {p.connected && (
                    <Button size="sm" variant="ghost" className="w-full text-destructive" disabled={busy}
                      onClick={() => run(async () => { await logout(p.id); })}>
                      Disconnect
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
