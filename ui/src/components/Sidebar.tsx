import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Sidebar as SidebarRoot, useSidebar } from "@/components/ui/sidebar";
import { ProvidersSheet } from "@/components/ProvidersSheet";
import { BranchField, RepoField } from "@/components/RepoField";
import { createSession, type AuthStatus, type SessionMeta } from "@/lib/api";
import { ago, cn } from "@/lib/utils";

const statusDot: Record<string, string> = {
  running: "bg-green-500 animate-pulse",
  idle: "bg-muted-foreground/40",
  exited: "bg-destructive/60",
};

export function Sidebar({
  auth, sessions, selected, onSelect,
}: {
  auth: AuthStatus | null;
  sessions: SessionMeta[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const [creating, setCreating] = useState(false);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");

  // On a phone the sidebar is a drawer over the session it just opened, so
  // picking one dismisses it; on desktop it stays open.
  const select = (id: string) => {
    onSelect(id);
    if (isMobile) setOpenMobile(false);
  };

  const create = async () => {
    const meta = await createSession({ repo: repo.trim(), branch: branch.trim() });
    setCreating(false);
    setRepo("");
    setBranch("");
    select(meta.id);
  };

  return (
    <SidebarRoot collapsible="offcanvas">
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
          <RepoField value={repo} onChange={(v) => { setRepo(v); setBranch(""); }} />
          {repo.trim() && <BranchField repo={repo} value={branch} onChange={setBranch} />}
          <Button type="submit" size="sm" className="w-full">Create</Button>
        </form>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => select(s.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted",
              selected === s.id && "bg-muted",
            )}
          >
            <span className={cn("size-2 shrink-0 rounded-full", statusDot[s.status ?? "idle"] ?? statusDot.idle)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{s.name}</span>
              {s.repo && (
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {s.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}{s.branch ? `@${s.branch}` : ""}
                </span>
              )}
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
      <ProvidersSheet auth={auth} />
    </SidebarRoot>
  );
}
