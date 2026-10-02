import { useEffect, useRef, useState } from "react";
import { ChatView } from "@/components/ChatView";
import { Panel, PANEL_TABS, type PanelTab } from "@/components/panel/Panel";
import { PanelContext } from "@/components/panel/panel-context";
import { useSession } from "@/hooks/useSession";
import type { ChatModel } from "@/lib/events";

// Artifact saves in the transcript, oldest first.
function artifactSaves(model: ChatModel): string[] {
  const ids: string[] = [];
  for (const item of model.items) {
    if (item.kind !== "assistant") continue;
    for (const b of item.blocks) {
      const id = (b.kind === "tool" && b.name === "artifact" && b.state === "done" && !b.isError)
        ? (b.details as { artifactId?: string } | undefined)?.artifactId : undefined;
      if (id) ids.push(id);
    }
  }
  return ids;
}

// Per-viewer layout prefs; storage can be unavailable (private windows).
function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted */ }
}

// One session's WebSocket, shared by the chat and the panel beside it.
export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  const [panelOpen, setPanelOpen] = useState(() => load("pids.panel", true));
  const [tab, setTab] = useState<PanelTab>(() => {
    const t = load<string>("pids.tab", "events");
    return (PANEL_TABS as readonly string[]).includes(t) ? (t as PanelTab) : "events";
  });

  const [artifact, setArtifact] = useState<string | null>(null);
  const open = (t: PanelTab, artifactId?: string) => {
    setPanelOpen(true);
    setTab(t);
    if (artifactId) setArtifact(artifactId);
  };

  // A save that arrives live (not in the joining snapshot) opens in the panel.
  const saves = artifactSaves(session.model);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!session.ready) { seen.current = null; return; }
    if (seen.current !== null && saves.length > seen.current) open("artifacts", saves.at(-1));
    seen.current = saves.length;
  });

  return (
    <PanelContext.Provider value={{ open }}>
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1">
        <ChatView
          session={session} panelOpen={panelOpen}
          onTogglePanel={() => { setPanelOpen(!panelOpen); save("pids.panel", !panelOpen); }}
        />
      </div>
      {panelOpen && (
        <aside className="hidden h-full w-[min(44rem,46vw)] shrink-0 border-l border-border md:block">
          <Panel
            sessionId={sessionId} session={session} tab={tab} onTab={(t) => { setTab(t); save("pids.tab", t); }}
            artifact={artifact} onArtifact={setArtifact} artifactRefresh={saves.length}
          />
        </aside>
      )}
    </div>
    </PanelContext.Provider>
  );
}
