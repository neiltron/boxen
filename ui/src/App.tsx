import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { SessionView } from "@/components/SessionView";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useDirectory } from "@/hooks/useDirectory";

export default function App() {
  const { sessions, auth } = useDirectory();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    // h-dvh, not h-screen: on iOS Safari the collapsing URL bar makes 100vh
    // taller than the visible area, pushing the composer off the bottom.
    // The provider writes the desktop collapse state to a cookie but never
    // reads it back, so it's read here.
    <SidebarProvider
      defaultOpen={!document.cookie.includes("sidebar_state=false")}
      className="h-dvh min-h-0 overflow-hidden bg-background text-foreground"
    >
      <Sidebar auth={auth} sessions={sessions} selected={selected} onSelect={setSelected} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        {selected ? (
          <SessionView key={selected} sessionId={selected} />
        ) : (
          <div className="flex h-full flex-col">
            <header className="flex items-center px-2 py-2.5"><SidebarTrigger /></header>
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Select or create a session
            </div>
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
