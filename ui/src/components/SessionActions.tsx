import { useRef, useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SessionActionsContext, useSessionActions } from "@/hooks/useSessionActions";
import { updateSession, type SessionMeta } from "@/lib/api";

// Lives above the filtered list: archiving a row cannot unmount its error or Undo.
export function SessionActionsProvider({ children }: { children: ReactNode }) {
  const [editing, setEditing] = useState<SessionMeta | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState<{ text: string; undo?: SessionMeta; error?: boolean } | null>(null);

  const archive = async (session: SessionMeta, archived: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const updated = await updateSession(session.id, { archived });
      setNotice({ text: archived ? `Archived “${updated.name}”. Running work continues.` : `Restored “${updated.name}”.`, undo: archived ? updated : undefined });
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    } finally { busy.current = false; setPending(false); }
  };
  const save = async () => {
    if (!editing || busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await updateSession(editing.id, { name: name.trim() });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
    finally { busy.current = false; setPending(false); }
  };

  return (
    <SessionActionsContext.Provider value={{ pending, archive, rename: (session) => { setEditing(session); setName(session.name); setError(""); } }}>
      {children}
      <Dialog.Root open={!!editing} onOpenChange={(open) => { if (!open && !pending) setEditing(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-5 shadow-lg">
            <Dialog.Title className="font-semibold">Rename session</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-muted-foreground">The name changes for everyone sharing this session.</Dialog.Description>
            <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <label className="block text-sm">Name
                <Input autoFocus value={name} maxLength={120} disabled={pending} onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
              </label>
              {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={pending} onClick={() => setEditing(null)}>Cancel</Button>
                <Button type="submit" disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save"}</Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
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
