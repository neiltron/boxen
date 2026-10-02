import { useEffect, useRef, useState } from "react";
import { Panel, Split, Stage, View, ViewType, Workspace, type WorkspaceHandle } from "@danfessler/trellis-react";
import "@danfessler/trellis/style.css";
import { ChatView } from "@/components/ChatView";
import { PANEL_VIEWS } from "@/components/panel/Panel";
import { SessionContext, useSessionContext, type PanelView } from "@/components/panel/session-context";
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

function Chat({ onTogglePanel }: { onTogglePanel: () => void }) {
  return <ChatView session={useSessionContext().session} onTogglePanel={onTogglePanel} />;
}

// One session's WebSocket shared by a Trellis workspace: the chat on the
// stage, and the panel views beside it in a resizable, dockable group. The
// layout persists per viewer (localStorage); bump `version` when the default
// layout changes.
export function SessionView({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  const ws = useRef<WorkspaceHandle>(null);
  const [artifact, setArtifact] = useState<string | null>(null);

  const restore = (viewId: string) => {
    const hidden = ws.current?.getSnapshot().hidden.find((h) => h.views.some((v) => v.id === viewId));
    if (hidden) ws.current?.restore(hidden.panelId);
  };
  const open = (view: PanelView, artifactId?: string) => {
    restore(view);
    ws.current?.focus(view);
    if (artifactId) setArtifact(artifactId);
  };
  // Hides every panel holding a panel view, or brings them all back.
  const togglePanel = () => {
    const snap = ws.current?.getSnapshot();
    if (!snap) return;
    const ids = new Set<string>(PANEL_VIEWS.map((v) => v.id));
    const hidden = snap.hidden.filter((h) => h.views.some((v) => ids.has(v.id)));
    if (hidden.length) hidden.forEach((h) => ws.current?.restore(h.panelId));
    else snap.views.filter((v) => ids.has(v.id)).forEach((v) => ws.current?.hide(v.id));
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
    <SessionContext.Provider value={{ sessionId, session, artifact, setArtifact, artifactRefresh: saves.length, open }}>
      <Workspace
        ref={ws} storageKey="pids.layout" version={1} label="Session"
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
        <Split weights={[3, 2]}>
          <Stage><View type="chat" id="chat" /></Stage>
          <Panel>
            {PANEL_VIEWS.map(({ id }) => <View key={id} type={id} id={id} />)}
          </Panel>
        </Split>
      </Workspace>
    </SessionContext.Provider>
  );
}
