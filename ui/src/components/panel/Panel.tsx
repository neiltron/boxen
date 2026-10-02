import { ArtifactsTab } from "@/components/panel/ArtifactsTab";
import { ChangesTab } from "@/components/panel/ChangesTab";
import { EventsTab } from "@/components/panel/EventsTab";
import { PreviewTab } from "@/components/panel/PreviewTab";
import { TerminalTab } from "@/components/panel/TerminalTab";
import { useSessionContext, type PanelView } from "@/components/panel/session-context";

function Artifacts() {
  const { sessionId, artifact, setArtifact, artifactRefresh } = useSessionContext();
  return <ArtifactsTab sessionId={sessionId} selected={artifact} onSelect={setArtifact} refresh={artifactRefresh} />;
}

// Finished calls that may have touched files: each one refetches the diff.
const MUTATING = new Set(["write", "edit", "bash"]);

function Changes() {
  const { sessionId, session } = useSessionContext();
  let done = 0;
  for (const item of session.model.items) {
    if (item.kind !== "assistant") continue;
    for (const b of item.blocks) if (b.kind === "tool" && b.state === "done" && MUTATING.has(b.name)) done++;
  }
  return <ChangesTab sessionId={sessionId} refresh={done} />;
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
