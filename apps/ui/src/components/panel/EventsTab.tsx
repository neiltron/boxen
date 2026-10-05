import { useState } from "react";
import type { ChatModel, LoggedEvent } from "@pi-durable-sessions/client";
import { cn } from "@/lib/utils";

// Streaming deltas and usage ticks outnumber everything else by far.
const NOISY = new Set(["message_update", "tool_execution_update", "usage_changed"]);

function summary(ev: LoggedEvent["ev"]): string {
  const e = ev as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (ev.type) {
    case "snapshot": return `${e.entries?.length ?? 0} entries${e.run ? ", run in progress" : ""}`;
    case "message_start": return e.message?.role ?? "";
    case "message_end": return `${e.entry?.kind ?? ""} #${e.entry?.id ?? ""}`;
    case "tool_execution_start":
    case "tool_execution_end": return e.toolName ?? "";
    case "submission": return `${e.record?.type} ${e.record?.status}${e.record?.reason ? ` (${e.record.reason})` : ""}`;
    case "agent_changed": return `${e.agent?.model?.modelId ?? ""} ${e.agent?.thinkingLevel ?? ""}`;
    case "task_failed": return e.message ?? "";
    default: return "";
  }
}

// The raw agent event stream this tab received: the snapshot it joined with,
// then one batch per commit. Click a row for its JSON.
export function EventsTab({ model }: { model: ChatModel }) {
  const [showNoisy, setShowNoisy] = useState(false);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const rows = model.log.filter((r) =>
    (showNoisy || !NOISY.has(r.ev.type)) && (!filter || r.ev.type.includes(filter)));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-xs">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by type…"
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
        <label className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={showNoisy} onChange={(e) => setShowNoisy(e.target.checked)} />
          deltas
        </label>
        <span className="shrink-0 tabular-nums text-muted-foreground">{rows.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
        {rows.map((r) => (
          <div key={r.n} className="border-b border-border/50">
            <button
              type="button" onClick={() => setOpen(open === r.n ? null : r.n)}
              className={cn("flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-muted", open === r.n && "bg-muted")}
            >
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {new Date(r.ts).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className="shrink-0">{r.ev.type}</span>
              <span className="truncate text-muted-foreground">{summary(r.ev)}</span>
            </button>
            {open === r.n && (
              <pre className="max-h-96 overflow-auto bg-muted/40 px-3 py-2 whitespace-pre-wrap break-all">
                {JSON.stringify(r.ev, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
