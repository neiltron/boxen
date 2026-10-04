import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Panel, Split, Stage, View, ViewType, Workspace, type WorkspaceHandle } from "@danfessler/trellis-react";
import "@danfessler/trellis/style.css";
import { ChatView } from "@/components/ChatView";
import { PANEL_VIEWS } from "@/components/panel/Panel";
import { SessionContext, useSessionContext, type PanelView } from "@/components/panel/session-context";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSession } from "@/hooks/useSession";
import { bindPanelShortcuts, restorePanels, togglePanels, WORKSPACE_LAYOUT_VERSION } from "@/lib/workspace";

const PANEL_VIEW_IDS = new Set<string>(PANEL_VIEWS.map((v) => v.id));

function Chat({ onTogglePanel }: { onTogglePanel: () => void }) {
  return <ChatView session={useSessionContext().session} onTogglePanel={onTogglePanel} />;
}

// One session's WebSocket shared by a Trellis workspace: the chat on the
// stage, and the panel views beside it in a resizable, dockable group. The
// layout persists per viewer (localStorage); bump `version` when the default
// layout changes. Phones get their own layout, stored under its own key so
// neither overwrites the other: the panel below the chat, hidden at first.
export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  const mobile = useIsMobile();
  const storageKey = mobile ? "pids.layout.mobile" : "pids.layout";
  const ws = useRef<WorkspaceHandle>(null);

  // The artifact on show is the reader's pick, until a save arrives live (not
  // in the joining snapshot): that one shows instead, and its view comes
  // forward (the effect below).
  const { saved } = session;
  const [pick, setPick] = useState<{ id: string | null; since: typeof saved }>({ id: null, since: null });
  const artifact = pick.since === saved ? pick.id : saved?.id ?? null;
  const setArtifact = (id: string | null) => setPick({ id, since: saved });

  const reveal = (view: PanelView) => {
    // Restore docking dependencies too, including when an artifact arrives live.
    if (ws.current) restorePanels(ws.current, PANEL_VIEW_IDS);
    ws.current?.focus(view);
  };
  const open = (view: PanelView, artifactId?: string) => {
    reveal(view);
    if (artifactId) setArtifact(artifactId);
  };
  const revealSave = useEffectEvent(() => reveal("artifacts"));
  useEffect(() => {
    if (saved) revealSave();
  }, [saved]);

  const togglePanel = () => {
    if (ws.current) togglePanels(ws.current, PANEL_VIEW_IDS);
  };

  // A phone's first visit starts with the chat alone. Trellis has no hidden
  // state in its initial layout, so check for a saved one before Trellis
  // writes it, and hide the panel once the handle arrives.
  const fresh = useMemo(() => {
    if (!mobile) return false;
    try {
      const saved = localStorage.getItem(storageKey);
      return !saved || JSON.parse(saved).version !== WORKSPACE_LAYOUT_VERSION;
    } catch { return true; }
  }, [mobile, storageKey]);
  const attach = useCallback((handle: WorkspaceHandle | null) => {
    ws.current = handle;
    if (!handle) return;
    if (fresh) handle.hide("panel");
    const unbind = bindPanelShortcuts(handle);
    return () => { unbind(); ws.current = null; };
  }, [fresh]);

  return (
    <SessionContext.Provider value={{ sessionId, session, artifact, setArtifact, open }}>
      <Workspace
        key={storageKey} ref={attach} storageKey={storageKey} version={WORKSPACE_LAYOUT_VERSION} label="Session"
        navigation={false} floating={false} className="pids-workspace h-full"
      >
        <ViewType id="chat" tabbar="never" closable={false} singleton scaling={false}>
          <Chat onTogglePanel={togglePanel} />
        </ViewType>
        {PANEL_VIEWS.map(({ id, title, Content }) => (
          <ViewType key={id} id={id} title={title} singleton closable={false} scaling={false} minSize={{ width: 320, height: 160 }}>
            <Content />
          </ViewType>
        ))}
        <Split axis={mobile ? "y" : "x"} weights={[3, 2]}>
          <Stage><View type="chat" id="chat" /></Stage>
          <Panel id="panel">
            {PANEL_VIEWS.map(({ id }) => <View key={id} type={id} id={id} />)}
          </Panel>
        </Split>
      </Workspace>
    </SessionContext.Provider>
  );
}
