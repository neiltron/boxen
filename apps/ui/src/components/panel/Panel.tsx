import { ArtifactsTab } from "@/components/panel/ArtifactsTab";
import { ChangesTab } from "@/components/panel/ChangesTab";
import { EventsTab } from "@/components/panel/EventsTab";
import { PreviewTab } from "@/components/panel/PreviewTab";
import { TerminalTab } from "@/components/panel/TerminalTab";
import { useSessionContext, type PanelView } from "@/components/panel/session-context";

// Each save refetches the list; each finished call that may have touched
// files refetches the diff.
function Artifacts() {
  const { sessionId, session, artifact, setArtifact } = useSessionContext();
  return <ArtifactsTab sessionId={sessionId} selected={artifact} onSelect={setArtifact} refresh={session.model.artifacts.length} />;
}

function Changes() {
  const { sessionId, session } = useSessionContext();
  return <ChangesTab sessionId={sessionId} refresh={session.model.mutations} />;
}

function Preview() {
  const { sessionId } = useSessionContext();
  return <PreviewTab key={sessionId} sessionId={sessionId} />;
}

function Events() {
  return <EventsTab model={useSessionContext().session.model} />;
}

// The dockable views beside the chat, in their default tab order.
export const PANEL_VIEWS: { id: PanelView; title: string; Content: () => React.ReactNode }[] = [
  { id: "artifacts", title: "Artifacts", Content: Artifacts },
  { id: "changes", title: "Changes", Content: Changes },
  { id: "preview", title: "Preview", Content: Preview },
  { id: "terminal", title: "Terminal", Content: TerminalTab },
  { id: "events", title: "Events", Content: Events },
];
