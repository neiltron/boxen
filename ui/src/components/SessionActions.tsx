import { useState, type ReactNode } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SessionActionsContext, useSessionActions } from "@/hooks/useSessionActions";
import { updateSession, type SessionMeta } from "@/lib/api";

type Notice = { text: string; undo?: SessionMeta; error?: boolean };

// Lives above the filtered list: archiving a row cannot unmount its error or Undo.
export function SessionActionsProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const update = async (id: string, patch: { name?: string; archived?: boolean }, done: (updated: SessionMeta) => Notice | null) => {
    setPending(true);
    try { setNotice(done(await updateSession(id, patch))); }
    catch (e) { setNotice({ text: (e as Error).message, error: true }); }
    finally { setPending(false); }
  };
  const archive = (session: SessionMeta, archived: boolean) => update(session.id, { archived }, (updated) => archived
    ? { text: `Archived “${updated.name}”. Running work continues.`, undo: updated }
    : { text: `Restored “${updated.name}”.` });
  const rename = (session: SessionMeta) => {
    const name = prompt("Rename session (changes it for everyone)", session.name)?.trim();
    if (name && name !== session.name) void update(session.id, { name }, () => null);
  };

  return (
    <SessionActionsContext.Provider value={{ pending, archive, rename }}>
      {children}
      {notice && (
        <div role={notice.error ? "alert" : "status"} className="fixed bottom-4 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 items-center gap-2 rounded-lg border bg-background p-3 text-sm shadow-lg">
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
          {notice.undo && <Button size="sm" variant="outline" disabled={pending} onClick={() => void archive(notice.undo!, false)}>Undo</Button>}
          <Button size="sm" variant="ghost" aria-label="Dismiss notification" onClick={() => setNotice(null)}>Dismiss</Button>
        </div>
      )}
    </SessionActionsContext.Provider>
  );
}

export function SessionActions({ session }: { session: SessionMeta }) {
  const actions = useSessionActions();
  const archived = session.archivedAt != null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="shrink-0" disabled={actions.pending} aria-label={`Actions for ${session.name}`}>
          <DotsThreeIcon className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={() => actions.rename(session)}>Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void actions.archive(session, !archived)}>{archived ? "Restore" : "Archive"}</DropdownMenuItem>
        <DropdownMenuLabel className="whitespace-normal font-normal">{archived ? "Restore to the active list for everyone." : "Hide from the active list for everyone. Running work continues."}</DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
