import { useState } from "react";
import { PaperPlaneRightIcon, StopIcon, CaretDownIcon, BrainIcon } from "@phosphor-icons/react";
import {
  MessageScrollerProvider, MessageScroller, MessageScrollerViewport,
  MessageScrollerContent, MessageScrollerItem, MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Button } from "@/components/ui/button";
import { ToolCallBlock } from "@/components/ToolCallBlock";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import type { Block, ChatItem } from "@/lib/events";

function ThinkingBlock({ block }: { block: Extract<Block, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 text-xs text-muted-foreground">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 hover:text-foreground">
        <BrainIcon className="size-3.5" />
        <span className={cn("italic", block.streaming && "shimmer")}>
          {block.streaming ? "thinking…" : "thought"}
        </span>
        <CaretDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="mt-1 border-l-2 border-border pl-3 whitespace-pre-wrap italic">{block.text}</div>}
    </div>
  );
}

function AssistantItem({ item }: { item: Extract<ChatItem, { kind: "assistant" }> }) {
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>
            <div className="w-full min-w-0 space-y-1">
              {item.blocks.map((b, i) => {
                if (b.kind === "text") {
                  return (
                    <div key={i} className="text-sm leading-relaxed whitespace-pre-wrap">
                      {b.text}
                      {b.streaming && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground/60 align-text-bottom" />}
                    </div>
                  );
                }
                if (b.kind === "thinking") return <ThinkingBlock key={i} block={b} />;
                return <ToolCallBlock key={i} block={b} />;
              })}
              {item.blocks.length === 0 && item.streaming && (
                <div className="shimmer text-sm text-muted-foreground">working…</div>
              )}
            </div>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

export function ChatView({ sessionId }: { sessionId: string }) {
  const { model, version, meta, ready, send } = useSession(sessionId);
  const [draft, setDraft] = useState("");
  void version;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send({ type: "prompt", message: text });
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <span className={cn(
          "size-2 shrink-0 rounded-full",
          model.running ? "animate-pulse bg-green-500" : "bg-muted-foreground/40",
        )} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{meta?.name ?? "…"}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{meta?.cwd}</div>
        </div>
        {model.running && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => send({ type: "abort" })}>
            <StopIcon className="size-3.5" /> Stop
          </Button>
        )}
      </header>

      <MessageScrollerProvider>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 px-4 py-6">
              {model.items.map((item) => (
                <MessageScrollerItem key={item.seq} scrollAnchor={item.kind === "user"}>
                  {item.kind === "user" && (
                    <Message align="end">
                      <MessageContent>
                        <Bubble variant={item.steer ? "tinted" : "default"}>
                          <BubbleContent>
                            <div className="text-sm whitespace-pre-wrap">{item.text}</div>
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  )}
                  {item.kind === "assistant" && <AssistantItem item={item} />}
                  {item.kind === "system" && (
                    <Marker variant="separator">
                      <MarkerContent className={cn("max-w-[70%] truncate", item.level === "error" && "text-destructive")}>
                        {item.text}
                      </MarkerContent>
                    </Marker>
                  )}
                </MessageScrollerItem>
              ))}
              {!ready && (
                <Marker variant="separator"><MarkerContent>connecting…</MarkerContent></Marker>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <footer className="border-t border-border p-3">
        <form
          className="mx-auto flex w-full max-w-3xl items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            rows={Math.min(6, draft.split("\n").length)}
            placeholder={model.running ? "Steer the running agent…" : "Message pi…"}
            className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={!ready}
          />
          <Button type="submit" size="icon" disabled={!ready || !draft.trim()}>
            <PaperPlaneRightIcon className="size-4" />
          </Button>
        </form>
      </footer>
    </div>
  );
}
