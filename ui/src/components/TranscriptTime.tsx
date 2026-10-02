import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { clockTime, exactTime, messageAge } from "@/lib/chat-time";
import { cn } from "@/lib/utils";

// One clock for the whole transcript: dates/recency update without a timer per
// row. Focus/visibility refresh handles suspended laptops and background tabs.
export function useTranscriptClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => { if (!document.hidden) setNow(Date.now()); };
    const timer = setInterval(tick, 30000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return now;
}

export function TranscriptTime({ ts, className, children }: { ts: number | null; className?: string; children?: React.ReactNode }) {
  if (ts === null) return null;
  const exact = exactTime(ts);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time tabIndex={0} dateTime={new Date(ts).toISOString()} aria-label={exact}
          className={cn("shrink-0 font-mono text-[11px] font-normal text-muted-foreground tabular-nums focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2", className)}>
          {children ?? clockTime(ts)}
        </time>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[11px]">{exact}</TooltipContent>
    </Tooltip>
  );
}

export function TranscriptRecency({ ts, now, working, status }: {
  ts: number | null; now: number; working: boolean; status: string;
}) {
  if (ts === null && !working) return null;
  return <div data-slot="transcript-recency" className="flex flex-wrap items-center justify-center gap-2 text-[11px] text-muted-foreground">
    {working ? <span>Agent working</span> : ts !== null && <TranscriptTime ts={ts}>Last message {messageAge(ts, now)}</TranscriptTime>}
    <span aria-hidden="true">·</span><span>{status}</span>
  </div>;
}
