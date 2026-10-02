import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSession, type SessionMeta } from "@/lib/api";
import { cn } from "@/lib/utils";

function ago(ts?: number): string {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const statusDot: Record<string, string> = {
  running: "bg-green-500 animate-pulse",
  idle: "bg-muted-foreground/40",
  exited: "bg-destructive/60",
};

export function Sidebar({
  sessions, selected, onSelect,
}: {
  sessions: SessionMeta[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const create = async () => {
    const meta = await createSession(name.trim() || "untitled");
    setCreating(false);
    setName("");
    onSelect(meta.id);
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-muted/20">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-sm font-semibold tracking-tight">pi sessions</span>
        <Button variant="ghost" size="icon-sm" onClick={() => setCreating(!creating)}>
          <PlusIcon className="size-4" />
        </Button>
      </div>

      {creating && (
        <form
          className="space-y-2 border-y border-border p-3"
          onSubmit={(e) => { e.preventDefault(); create(); }}
        >
          <Input placeholder="session name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Button type="submit" size="sm" className="w-full">Create</Button>
        </form>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted",
              selected === s.id && "bg-muted",
            )}
          >
            <span className={cn("size-2 shrink-0 rounded-full", statusDot[s.status ?? "idle"] ?? statusDot.idle)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{s.name}</span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {s.cwd.split("/").slice(-2).join("/")}
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{ago(s.lastActivity)}</span>
          </button>
        ))}
        {sessions.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            No sessions yet — create one with +
          </div>
        )}
      </nav>
    </aside>
  );
}
