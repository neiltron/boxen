import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { useDirectory } from "@/hooks/useDirectory";

export default function App() {
  const sessions = useDirectory();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar sessions={sessions} selected={selected} onSelect={setSelected} />
      <main className="min-w-0 flex-1">
        {selected ? (
          <ChatView key={selected} sessionId={selected} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select or create a session
          </div>
        )}
      </main>
    </div>
  );
}
