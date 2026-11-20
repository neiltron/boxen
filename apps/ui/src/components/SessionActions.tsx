import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SessionActionsContext, useSessionActions } from "@/hooks/useSessionActions";
import { updateSession, type SessionMeta } from "@/lib/api";

type Notice = { text: string; undo?: SessionMeta; error?: boolean };

// Lives above the filtered list: archiving a row cannot unmount its error or Undo.
export function SessionActionsProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(false);
  // Kept after Dismiss so the toast keeps its content while it fades out.
  const [notice, setNotice] = useState<Notice | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renamingRef = useRef<SessionMeta | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const lastFocusOutsideToastRef = useRef<HTMLElement | null>(null);

  const renameTitleId = useId();
  const renameDescId = useId();
  const renameInputId = useId();

  const update = useCallback(async (id: string, patch: { name?: string; archived?: boolean }, done: (updated: SessionMeta) => Notice | null) => {
    setPending(true);
    try {
      const next = done(await updateSession(id, patch));
      if (next) setNotice(next);
    }
    catch (e) { setNotice({ text: (e as Error).message, error: true }); }
    finally { setPending(false); }
  }, []);

  const archive = useCallback((session: SessionMeta, archived: boolean) => update(session.id, { archived }, (updated) => archived
    ? { text: `Archived “${updated.name}”. Running work continues.`, undo: updated }
    : { text: `Restored “${updated.name}”.` }), [update]);

  const rename = useCallback((session: SessionMeta) => {
    const dialog = dialogRef.current, input = renameInputRef.current;
    if (!dialog || !input) return;
    renamingRef.current = session;
    input.value = session.name;
    dialog.returnValue = "";
    dialog.showModal();
    input.select();
  }, []);

  const onRenameClose = () => {
    const target = renamingRef.current;
    renamingRef.current = null;
    const nextName = renameInputRef.current?.value.trim();
    if (dialogRef.current?.returnValue === "save" && target && nextName && nextName !== target.name) {
      void update(target.id, { name: nextName }, () => null);
    }
  };

  // Remember where focus was before it entered the toast, so Dismiss can put it back.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && !toastRef.current?.contains(event.target)) lastFocusOutsideToastRef.current = event.target;
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => document.removeEventListener("focusin", onFocusIn, true);
  }, []);

  useEffect(() => {
    if (notice) toastRef.current?.togglePopover(true);
  }, [notice]);

  const dismissNotice = () => {
    const el = toastRef.current;
    const focusWasInside = el?.contains(document.activeElement);
    el?.hidePopover();
    if (focusWasInside && lastFocusOutsideToastRef.current?.isConnected) lastFocusOutsideToastRef.current.focus();
  };

  return (
    <SessionActionsContext.Provider value={{ pending, archive, rename }}>
      {children}
      {/* Modal dialogs default to closedby="closerequest": Escape cancels, a backdrop tap keeps the typed name. */}
      <dialog
        ref={dialogRef}
        onClose={onRenameClose}
        aria-labelledby={renameTitleId}
        aria-describedby={renameDescId}
        className="boxen-dialog w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-lg"
      >
        <form method="dialog" className="flex flex-col gap-4 p-4">
          <div className="space-y-1">
            <h2 id={renameTitleId} className="text-sm font-medium text-foreground">
              Rename session
            </h2>
            <p id={renameDescId} className="text-xs text-muted-foreground">
              Changes the session name for everyone.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={renameInputId} className="block text-xs font-medium text-foreground">
              Session name
            </label>
            <Input ref={renameInputRef} id={renameInputId} name="name" autoComplete="off" className="text-base sm:text-xs" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => dialogRef.current?.close("cancel")}>
              Cancel
            </Button>
            <Button type="submit" size="sm" value="save">
              Save
            </Button>
          </div>
        </form>
      </dialog>
      <div role="region" aria-label="Notifications">
        {/* Always rendered, outside the popover, so text changes are announced even while the toast is hidden. */}
        <div role="status" className="sr-only">{notice && !notice.error ? notice.text : ""}</div>
        <div role="alert" className="sr-only">{notice?.error ? notice.text : ""}</div>
        <div
          ref={toastRef}
          popover="manual"
          className="boxen-toast w-[calc(100%-2rem)] max-w-lg flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-3 text-sm text-foreground shadow-lg"
        >
          {notice && (
            <>
              <span className="min-w-0 flex-1 break-words">{notice.text}</span>
              {notice.undo && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => void archive(notice.undo!, false)}>
                  Undo
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" aria-label="Dismiss notification" onClick={dismissNotice}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      </div>
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
