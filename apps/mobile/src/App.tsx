import { useEffect, useState } from "react";
import { ChatView } from "@/components/ChatView";
import { SessionActionsProvider } from "@/components/SessionActions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarInset, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, useSidebar,
} from "@/components/ui/sidebar";
import { useDirectory } from "@/hooks/useDirectory";
import { useSession, useSessionClient } from "@/hooks/useSession";
import { ago, cn } from "@/lib/utils";
import { finishLogin, listKeys, localSession, setKey, startLogin } from "./local.ts";
import type { Connected } from "./agent.worker.ts";

// Model providers, and a GitHub token for the github tool (read-only use;
// a fine-grained token with read access to the repos you'll ask about).
const PROVIDERS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", google: "Google", github: "GitHub" };

// API keys, sign-ins and the GitHub token for the agent on this phone. They stay in this app's
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
      <SidebarGroupLabel>Keys</SidebarGroupLabel>
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
              After signing in, the page fails to load. Copy its whole address (Share → Copy, or tap the address bar and select all;
              it starts with http://127.0.0.1:1455/auth/callback?code=) and paste it here.
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

// The conversation on this phone, then the system's Sessions (the Directory's
// live list, as the web app's sidebar shows it).
function Conversations({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const { sessions } = useDirectory();
  const { setOpenMobile } = useSidebar();
  const pick = (id: string | null) => { onSelect(id); setOpenMobile(false); };
  return (
    <>
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={selected === null} onClick={() => pick(null)}>On this phone</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Sessions</SidebarGroupLabel>
        <SidebarMenu>
          {sessions.filter((s) => s.archivedAt == null).map((s) => (
            <SidebarMenuItem key={s.id}>
              <SidebarMenuButton isActive={selected === s.id} onClick={() => pick(s.id)} className="h-auto py-1.5">
                <span className={cn("size-2 shrink-0 rounded-full", s.status === "running" ? "animate-pulse bg-green-500" : "bg-muted-foreground/40")} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                {s.lastActivity != null && <span className="shrink-0 text-xs text-muted-foreground">{ago(s.lastActivity)}</span>}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}

function LocalChat() {
  return <ChatView session={useSessionClient(localSession)} actions={false} />;
}

function RemoteChat({ id }: { id: string }) {
  return <ChatView session={useSession(id)} />;
}

export default function App() {
  const [selected, setSelected] = useState<string | null>(null); // a Session's id, or null for this phone's
  return (
    // h-dvh, not h-screen: iOS Safari's collapsing URL bar (as apps/ui's App).
    <SidebarProvider defaultOpen={false} className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <SessionActionsProvider>
        <Sidebar>
          <SidebarContent>
            <Conversations selected={selected} onSelect={setSelected} />
            <Keys />
          </SidebarContent>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          {selected ? <RemoteChat key={selected} id={selected} /> : <LocalChat />}
        </SidebarInset>
      </SessionActionsProvider>
    </SidebarProvider>
  );
}
