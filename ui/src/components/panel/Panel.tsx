import { Tabs } from "radix-ui";
import type { SessionHandle } from "@/hooks/useSession";
import { EventsTab } from "@/components/panel/EventsTab";

export const PANEL_TABS = ["artifacts", "changes", "preview", "terminal", "events"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

const LABELS: Record<PanelTab, string> = {
  artifacts: "Artifacts", changes: "Changes", preview: "Preview", terminal: "Terminal", events: "Events",
};

function Soon({ what }: { what: string }) {
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{what}</div>;
}

// Full-height panel beside the chat: everything about the session that is
// not the conversation itself.
export function Panel({ session, tab, onTab }: { session: SessionHandle; tab: PanelTab; onTab: (t: PanelTab) => void }) {
  return (
    <Tabs.Root value={tab} onValueChange={(v) => onTab(v as PanelTab)} className="flex h-full min-h-0 flex-col">
      <Tabs.List className="flex shrink-0 gap-1 border-b border-border px-2 py-1.5">
        {PANEL_TABS.map((t) => (
          <Tabs.Trigger
            key={t} value={t}
            className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground"
          >
            {LABELS[t]}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="artifacts" className="min-h-0 flex-1"><Soon what="Artifacts" /></Tabs.Content>
      <Tabs.Content value="changes" className="min-h-0 flex-1"><Soon what="Changes" /></Tabs.Content>
      <Tabs.Content value="preview" className="min-h-0 flex-1"><Soon what="Preview" /></Tabs.Content>
      <Tabs.Content value="terminal" className="min-h-0 flex-1"><Soon what="Terminal" /></Tabs.Content>
      <Tabs.Content value="events" className="min-h-0 flex-1"><EventsTab model={session.model} /></Tabs.Content>
    </Tabs.Root>
  );
}
