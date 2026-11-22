import { Fragment, useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { setDefaultAgent, type ModelInfo } from "@/lib/api";
import type { SessionHandle } from "@/hooks/useSession";
import { cn } from "@/lib/utils";

const connection = (provider: string) =>
  provider === "openai" ? "ChatGPT sign-in" : provider === "openai-codex" ? "Codex (legacy)" : provider;

// The composer's model control, adapted from boxen-legacy's. The session cell lists
// what its login can use; a choice is a durable configure that applies from
// the next model request, so it works mid-run too. The cell's agent_changed
// event is the confirmation, for every tab at once. Like the rest of the
// composer it is disabled while the session is not joined.
export function ModelPicker({ session }: { session: SessionHandle }) {
  const { model, models, ready } = session;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ error?: boolean; text: string } | null>(null);

  const current = model.agent.model;
  const currentInfo = models?.find((m) => m.provider === current?.provider && m.id === current?.modelId);
  const q = query.trim().toLowerCase();
  const shown = (models ?? [])
    .filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q))
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

  const choose = (m: ModelInfo) => {
    const level = model.agent.thinkingLevel;
    session.configure({
      model: { provider: m.provider, modelId: m.id },
      thinkingLevel: level && m.thinkingLevels.includes(level) ? level : undefined,
    });
    setOpen(false);
  };

  const makeDefault = async () => {
    if (!current || saving) return;
    const agent = { model: { ...current }, thinkingLevel: model.agent.thinkingLevel };
    setSaving(true);
    setNotice(null);
    try {
      await setDefaultAgent(agent);
      setNotice({ text: `Default for new sessions: ${agent.model.provider}/${agent.model.modelId}${agent.thinkingLevel ? ` · ${agent.thinkingLevel}` : ""}. Existing sessions are unchanged.` });
    } catch (e) {
      setNotice({ error: true, text: e instanceof Error ? e.message : "Could not save the default" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(""); setNotice(null); session.listModels(); } }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Choose model"
          disabled={!ready}
          className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="truncate font-mono">{current?.modelId ?? "no model"}</span>
          {model.agent.thinkingLevel && <span className="text-muted-foreground/70">· {model.agent.thinkingLevel}</span>}
          <CaretDownIcon aria-hidden="true" className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[min(22rem,calc(100vw-2rem))] space-y-2 rounded-lg">
        <Input aria-label="Search models" value={query} placeholder="Search models…" onChange={(e) => setQuery(e.target.value)} className="text-base sm:text-xs" />
        {!models && <p className="text-xs text-muted-foreground">Checking…</p>}
        {models?.length === 0 && <p className="text-xs text-muted-foreground">No models. Sign in from the sidebar first.</p>}
        {!!currentInfo?.thinkingLevels.length && (
          <div className="flex flex-wrap gap-1">
            {currentInfo.thinkingLevels.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={model.agent.thinkingLevel === level}
                onClick={() => session.configure({ model: current, thinkingLevel: level })}
                className={cn("touch-target inline-flex items-center justify-center rounded-full border border-border px-2 py-0.5 text-xs hover:bg-muted",
                  model.agent.thinkingLevel === level && "border-foreground/40 bg-muted text-foreground")}
              >
                {level}
              </button>
            ))}
          </div>
        )}
        <div className="space-y-1 border-b border-border pb-2">
          <button
            type="button"
            disabled={!ready || !currentInfo || saving}
            onClick={() => void makeDefault()}
            className="touch-target rounded-sm px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            {saving ? "Saving default…" : "Make default for new sessions"}
          </button>
          <p className="px-2 text-xs text-muted-foreground">Saves this model and thinking level for the fleet.</p>
          {notice && <p role={notice.error ? "alert" : "status"} className={cn("px-2 text-xs", notice.error ? "text-destructive" : "text-muted-foreground")}>{notice.text}</p>}
        </div>
        <div className="scroll-shadows max-h-64 overflow-y-auto">
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
                {m.provider === current?.provider && m.id === current?.modelId && <CheckIcon aria-hidden="true" className="size-4 shrink-0" />}
              </button>
            </Fragment>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
