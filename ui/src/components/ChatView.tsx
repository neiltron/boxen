import { useLayoutEffect, useRef, useState } from "react";
import { PaperPlaneRightIcon, StopIcon, CaretDownIcon, BrainIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import {
  MessageScrollerProvider, MessageScroller, MessageScrollerViewport,
  MessageScrollerContent, MessageScrollerItem, MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Button } from "@/components/ui/button";
import {
  InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea,
} from "@/components/ui/input-group";
import { Markdown } from "@/components/Markdown";
import { ModelPicker } from "@/components/ModelPicker";
import { ToolCallBlock } from "@/components/ToolCallBlock";
import type { SessionHandle } from "@/hooks/useSession";
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
                    <div key={i}>
                      <Markdown text={b.text} />
                      {b.streaming && <span className="inline-block h-4 w-2 animate-pulse bg-foreground/60 align-text-bottom" />}
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

export function ChatView({ session, onTogglePanel }: { session: SessionHandle; onTogglePanel: () => void }) {
  const { model, meta, ready, send } = session;
  const [draft, setDraft] = useState("");

  // Stick to the end while the reader is there. The scroller's own follow
  // mode drops out when content shrinks (a finished tool card loses its live
  // output tail, the browser clamps scrollTop, and that reads as scrolling
  // up), so "at end" is tracked from scroll positions and re-applied after
  // every render.
  const viewport = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const v = viewport.current;
    if (v && atEnd.current) v.scrollTop = v.scrollHeight;
  });

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send({ type: "prompt", message: text });
    setDraft("");
    atEnd.current = true; // your own message brings the view back to the end
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <span className={cn(
          "size-2 shrink-0 rounded-full",
          model.running ? "animate-pulse bg-green-500" : "bg-muted-foreground/40",
        )} />
        <div className="min-w-0 truncate text-sm font-medium">{meta?.name ?? "…"}</div>
        <Button
          variant="ghost" size="icon-sm" className="ml-auto"
          aria-label="Show or hide the panel"
          onClick={onTogglePanel}
        >
          <SidebarSimpleIcon className="size-4 -scale-x-100" />
        </Button>
      </header>

      <MessageScrollerProvider autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport
            ref={viewport}
            onScroll={(e) => {
              const v = e.currentTarget;
              atEnd.current = v.scrollHeight - v.scrollTop - v.clientHeight < 32;
            }}
          >
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 px-4 py-6">
              {model.items.map((item) => (
                <MessageScrollerItem key={item.seq}>
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

      <footer className="p-3 pt-1.5">
        <form className="mx-auto w-full max-w-3xl" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <InputGroup className="rounded-2xl">
            <InputGroupTextarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              enterKeyHint="enter"
              onKeyDown={(e) => {
                // Touch keyboards keep Return for newlines; the Send button submits.
                if (e.key === "Enter" && !e.shiftKey
                  && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229
                  && !window.matchMedia("(pointer: coarse)").matches) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder={model.running ? "Steer the running agent…" : "Message pi…"}
              className="max-h-44 min-h-0 py-2.5 text-base [field-sizing:content] sm:text-sm"
              disabled={!ready}
            />
            <InputGroupAddon align="block-end" className="gap-1.5 pb-1 pt-0">
              <ModelPicker session={session} />
              {model.running && (
                <InputGroupButton
                  type="button" variant="outline" size="icon-sm" className="ml-auto rounded-full"
                  aria-label="Stop the agent" onClick={() => send({ type: "abort" })}
                >
                  <StopIcon className="size-3.5" />
                </InputGroupButton>
              )}
              <InputGroupButton
                type="submit" variant="default" size="icon-sm"
                className={cn("rounded-full", !model.running && "ml-auto")}
                aria-label="Send" disabled={!ready || !draft.trim()}
              >
                <PaperPlaneRightIcon className="size-3.5" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </footer>
    </div>
  );
}
