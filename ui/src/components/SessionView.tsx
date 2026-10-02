import { useState } from "react";
import { ChatView } from "@/components/ChatView";
import { Panel, PANEL_TABS, type PanelTab } from "@/components/panel/Panel";
import { useSession } from "@/hooks/useSession";

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

  return (
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1">
        <ChatView
          session={session} panelOpen={panelOpen}
          onTogglePanel={() => { setPanelOpen(!panelOpen); save("pids.panel", !panelOpen); }}
        />
      </div>
      {panelOpen && (
        <aside className="hidden h-full w-[min(44rem,46vw)] shrink-0 border-l border-border md:block">
          <Panel session={session} tab={tab} onTab={(t) => { setTab(t); save("pids.tab", t); }} />
        </aside>
      )}
    </div>
  );
}
