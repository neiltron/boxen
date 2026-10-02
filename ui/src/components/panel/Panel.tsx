import { ArtifactsTab } from "@/components/panel/ArtifactsTab";
import { EventsTab } from "@/components/panel/EventsTab";
import { useSessionContext, type PanelView } from "@/components/panel/session-context";

function Soon({ what }: { what: string }) {
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{what}</div>;
}

function Artifacts() {
  const { sessionId, artifact, setArtifact, artifactRefresh } = useSessionContext();
  return <ArtifactsTab sessionId={sessionId} selected={artifact} onSelect={setArtifact} refresh={artifactRefresh} />;
}

function Events() {
  return <EventsTab model={useSessionContext().session.model} />;
}

// The dockable views beside the chat, in their default tab order.
export const PANEL_VIEWS: { id: PanelView; title: string; Content: () => React.ReactNode }[] = [
  { id: "artifacts", title: "Artifacts", Content: Artifacts },
  { id: "changes", title: "Changes", Content: () => <Soon what="Changes" /> },
  { id: "preview", title: "Preview", Content: () => <Soon what="Preview" /> },
  { id: "terminal", title: "Terminal", Content: () => <Soon what="Terminal" /> },
  { id: "events", title: "Events", Content: Events },
];
