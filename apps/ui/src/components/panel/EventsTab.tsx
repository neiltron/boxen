import { memo, useMemo, useState } from "react";
import type { ChatModel, LoggedEvent } from "@boxen/client";

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

const EventRow = memo(function EventRow({ row }: { row: LoggedEvent }) {
  const time = useMemo(
    () => new Date(row.ts).toLocaleTimeString([], { hour12: false }),
    [row.ts],
  );
  // Lazy body: up to 1000 rows, and Find-in-page over raw event JSON isn't
  // worth serializing every one up front.
  const [open, setOpen] = useState(false);

  return (
    <details
      className="boxen-details group border-b border-border/50"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1 text-left hover:bg-muted group-open:bg-muted">
        <span className="shrink-0 text-muted-foreground tabular-nums">{time}</span>
        <span className="shrink-0">{row.ev.type}</span>
        <span className="truncate text-muted-foreground">{summary(row.ev)}</span>
      </summary>
      {open && (
        <pre className="max-h-96 overflow-auto bg-muted/40 px-3 py-2 whitespace-pre-wrap break-all">
          {JSON.stringify(row.ev, null, 2)}
        </pre>
      )}
    </details>
  );
});

// The raw agent event stream this tab received: the snapshot it joined with,
// then one batch per commit. Click a row for its JSON.
export function EventsTab({ model }: { model: ChatModel }) {
  const [showNoisy, setShowNoisy] = useState(false);
  const [filter, setFilter] = useState("");
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
          <EventRow key={r.n} row={r} />
        ))}
      </div>
    </div>
  );
}
