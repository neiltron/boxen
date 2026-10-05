import { useEffect, useState } from "react";
import { ChatView } from "@/components/ChatView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarInset, SidebarProvider,
} from "@/components/ui/sidebar";
import { useSessionClient } from "@/hooks/useSession";
import { finishLogin, listKeys, localSession, setKey, startLogin } from "./local.ts";
import type { Connected } from "./agent.worker.ts";

const PROVIDERS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", google: "Google" };

// API keys and sign-ins for the agent on this phone. They stay in this app's
// storage and go only to the provider they belong to.
function Keys() {
  const [connected, setConnected] = useState<Connected[]>([]);
  const [signInUrl, setSignInUrl] = useState<string | null>(null); // set while waiting for the pasted address
  const [redirect, setRedirect] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listKeys().then(setConnected, (e: Error) => setError(e.message)); }, []);

  const done = (keys: Connected[]) => { setConnected(keys); setDraft(""); setRedirect(""); setSignInUrl(null); setError(null); };
  const failed = (e: Error) => setError(e.message);
  const save = (id: string, key: string) => setKey(id, key).then(done, failed);
  // A link, not window.open: iOS blocks a window opened after the await. The
  // sign-in ends on a localhost address the phone can't load; its address bar holds what we need.
  const signIn = () => startLogin("openai").then(setSignInUrl, failed);

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Model keys</SidebarGroupLabel>
      <SidebarGroupContent className="space-y-2 px-2 text-sm">
        {connected.map(({ provider: id, type }) => (
          <div key={id} className="flex items-center justify-between">
            <span>{PROVIDERS[id] ?? id}{type === "oauth" && id === "openai" ? " (ChatGPT)" : ""}</span>
            <Button size="sm" variant="ghost" onClick={() => void save(id, "")}>Remove</Button>
          </div>
        ))}
        {signInUrl ? (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void finishLogin(redirect.trim()).then(done, failed); }}>
            <a href={signInUrl} target="_blank" rel="noopener noreferrer" className="block font-medium underline">Open ChatGPT sign-in</a>
            <p className="text-muted-foreground">
              After signing in, the page fails to load. Copy its address (it starts with http://127.0.0.1:1455) and paste it here.
            </p>
            <Input placeholder="http://127.0.0.1:1455/auth/callback?…" value={redirect} onChange={(e) => setRedirect(e.target.value)} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" className="flex-1" disabled={!redirect.trim()}>Finish sign-in</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setSignInUrl(null)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <Button size="sm" variant="outline" className="w-full" onClick={() => void signIn()}>Sign in with ChatGPT</Button>
        )}
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void save(provider, draft.trim()); }}>
          <select
            value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider"
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-base sm:text-sm"
          >
            {Object.entries(PROVIDERS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <Input type="password" autoComplete="off" placeholder="API key" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit" size="sm" className="w-full" disabled={!draft.trim()}>Save key</Button>
        </form>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export default function App() {
  const session = useSessionClient(localSession);
  return (
    // h-dvh, not h-screen: iOS Safari's collapsing URL bar (as apps/ui's App).
    <SidebarProvider defaultOpen={false} className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <Sidebar>
        <SidebarContent><Keys /></SidebarContent>
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <ChatView session={session} actions={false} />
      </SidebarInset>
    </SidebarProvider>
  );
}
