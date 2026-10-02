import { Fragment, useState } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import type { ModelInfo } from "@/lib/api";
import type { SessionHandle } from "@/hooks/useSession";
import { cn } from "@/lib/utils";

const connection = (provider: string) =>
  provider === "openai" ? "ChatGPT sign-in" : provider === "openai-codex" ? "Codex (legacy)" : provider;

// The composer's model control, adapted from boxen's. The session cell lists
// what its login can use; a choice is a durable configure that applies from
// the next model request, so it works mid-run too. The cell's agent_changed
// event is the confirmation, for every tab at once.
export function ModelPicker({ session }: { session: SessionHandle }) {
  const { model, models, send } = session;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const current = model.agent.model;
  const currentInfo = models?.find((m) => m.provider === current?.provider && m.id === current?.modelId);
  const q = query.trim().toLowerCase();
  const shown = (models ?? [])
    .filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q))
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

  const choose = (m: ModelInfo) => {
    const level = model.agent.thinkingLevel;
    send({
      type: "configure",
      model: { provider: m.provider, modelId: m.id },
      thinkingLevel: level && m.thinkingLevels.includes(level) ? level : undefined,
    });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(""); send({ type: "models" }); } }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Choose model"
          className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <span className="truncate font-mono">{current?.modelId ?? "no model"}</span>
          {model.agent.thinkingLevel && <span className="text-muted-foreground/70">· {model.agent.thinkingLevel}</span>}
          <CaretDownIcon className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[min(22rem,calc(100vw-2rem))] space-y-2 rounded-lg">
        <Input value={query} placeholder="Search models…" onChange={(e) => setQuery(e.target.value)} />
        {!models && <p className="text-xs text-muted-foreground">Checking…</p>}
        {models?.length === 0 && <p className="text-xs text-muted-foreground">No models. Sign in from the sidebar first.</p>}
        {!!currentInfo?.thinkingLevels.length && (
          <div className="flex flex-wrap gap-1">
            {currentInfo.thinkingLevels.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => send({ type: "configure", model: current, thinkingLevel: level })}
                className={cn("rounded-full border border-border px-2 py-0.5 text-xs hover:bg-muted",
                  model.agent.thinkingLevel === level && "border-foreground/40 bg-muted text-foreground")}
              >
                {level}
              </button>
            ))}
          </div>
        )}
        <div className="max-h-64 overflow-y-auto">
          {shown.map((m, i) => (
            <Fragment key={`${m.provider}/${m.id}`}>
              {shown[i - 1]?.provider !== m.provider && (
                <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{connection(m.provider)}</div>
              )}
              <button
                type="button"
                onClick={() => choose(m)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{m.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{m.id}</span>
                </span>
                {m.provider === current?.provider && m.id === current?.modelId && <CheckIcon className="size-4 shrink-0" />}
              </button>
            </Fragment>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
