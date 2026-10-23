import { useContext, useState } from "react";
import {
  CaretRightIcon, TerminalIcon, FileTextIcon, PencilSimpleIcon,
  WrenchIcon, CircleNotchIcon, CheckIcon, XIcon, ShapesIcon, ArrowSquareOutIcon,
} from "@phosphor-icons/react";
import { SessionContext } from "@/components/panel/session-context";
import { cn } from "@/lib/utils";
import type { Block } from "@boxen/client";

type ToolBlock = Extract<Block, { kind: "tool" }>;

function toolIcon(name: string) {
  if (name === "artifact") return ShapesIcon;
  if (name.includes("bash")) return TerminalIcon;
  if (name.includes("read") || name.includes("grep") || name.includes("find")) return FileTextIcon;
  if (name.includes("edit") || name.includes("write")) return PencilSimpleIcon;
  return WrenchIcon;
}

function argsPreview(block: ToolBlock): string {
  const args = (block.args ?? {}) as Record<string, unknown>;
  const first =
    args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.url ?? args.title;
  if (typeof first === "string") return first;
  const s = block.argsText || JSON.stringify(args);
  return s === "{}" ? "" : s;
}

export function ToolCallBlock({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const panel = useContext(SessionContext);
  const { artifactId } = block;
  const Icon = toolIcon(block.name);
  const preview = argsPreview(block);

  return (
    <div className="my-1 w-full max-w-full overflow-hidden rounded-lg border border-border bg-muted/40 text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
      >
        <CaretRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{block.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{preview}</span>
        {artifactId && (
          <span
            role="link" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); panel?.open("artifacts", artifactId); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); panel?.open("artifacts", artifactId); } }}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
          >
            open <ArrowSquareOutIcon className="size-3" />
          </span>
        )}
        {block.state === "done" ? (
          block.isError
            ? <XIcon className="size-3.5 shrink-0 text-destructive" />
            : <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <CircleNotchIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {block.args != null && (
            <pre className="max-h-40 overflow-auto rounded bg-background p-2 font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(block.args, null, 2)}
            </pre>
          )}
          {block.output && (
            <pre className={cn(
              "max-h-72 overflow-auto rounded bg-background p-2 font-mono text-xs whitespace-pre-wrap",
              block.isError && "text-destructive",
            )}>
              {block.output}
            </pre>
          )}
        </div>
      )}
      {!open && block.state === "running" && block.output && (
        <pre className="max-h-24 overflow-hidden border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground whitespace-pre-wrap [mask-image:linear-gradient(to_bottom,black_60%,transparent)]">
          {block.output.slice(-800)}
        </pre>
      )}
    </div>
  );
}
