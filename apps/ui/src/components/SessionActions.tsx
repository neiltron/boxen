import { useCallback, useEffect, useId, useRef, useState, type DialogHTMLAttributes, type ReactNode } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SessionActionsContext, useSessionActions } from "@/hooks/useSessionActions";
import { updateSession, type SessionMeta } from "@/lib/api";

type Notice = { text: string; undo?: SessionMeta; error?: boolean };
type AriaNotifyDocument = Document & {
  ariaNotify?: (announcement: string, options?: { priority?: "normal" | "high" }) => void;
};

const supportsPopover = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
const supportsAriaNotify = typeof document !== "undefined" && "ariaNotify" in document;

// Lives above the filtered list: archiving a row cannot unmount its error or Undo.
export function SessionActionsProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastNotice, setLastNotice] = useState<Notice | null>(null);
  const [renaming, setRenaming] = useState<SessionMeta | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const dialogRef = useRef<HTMLDialogElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renamingRef = useRef<SessionMeta | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const lastFocusOutsideToastRef = useRef<HTMLElement | null>(null);

  const renameTitleId = useId();
  const renameDescId = useId();
  const renameInputId = useId();
  const toastId = useId();

  const showNotice = useCallback((next: Notice | null) => {
    setNotice(next);
    if (next) setLastNotice(next);
  }, []);

  const update = useCallback(async (id: string, patch: { name?: string; archived?: boolean }, done: (updated: SessionMeta) => Notice | null) => {
    setPending(true);
    try { showNotice(done(await updateSession(id, patch))); }
    catch (e) { showNotice({ text: (e as Error).message, error: true }); }
    finally { setPending(false); }
  }, [showNotice]);

  const archive = useCallback((session: SessionMeta, archived: boolean) => update(session.id, { archived }, (updated) => archived
    ? { text: `Archived “${updated.name}”. Running work continues.`, undo: updated }
    : { text: `Restored “${updated.name}”.` }), [update]);

  const rename = useCallback((session: SessionMeta) => {
    renamingRef.current = session;
    setRenameDraft(session.name);
    setRenaming(session);
  }, []);

  // Wire native <dialog> close handling and Safari's closedby="any" fallback.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const onClose = () => {
      const result = dialog.returnValue;
      dialog.returnValue = "";
      const target = renamingRef.current;
      renamingRef.current = null;
      const nextName = (renameInputRef.current?.value ?? "").trim();
      setRenaming(null);
      if (result === "save" && target && nextName && nextName !== target.name) {
        void update(target.id, { name: nextName }, () => null);
      }
    };
    dialog.addEventListener("close", onClose);

    let removeFallback: (() => void) | undefined;
    if (typeof HTMLDialogElement !== "undefined" && !("closedBy" in HTMLDialogElement.prototype)) {
      const outside = (e: PointerEvent) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let pressedOutside = false;
      const onPointerDown = (e: PointerEvent) => {
        pressedOutside = outside(e);
      };
      const onPointerUp = (e: PointerEvent) => {
        if (pressedOutside && outside(e)) dialog.close();
        pressedOutside = false;
      };
      dialog.addEventListener("pointerdown", onPointerDown);
      dialog.addEventListener("pointerup", onPointerUp);
      removeFallback = () => {
        dialog.removeEventListener("pointerdown", onPointerDown);
        dialog.removeEventListener("pointerup", onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener("close", onClose);
      removeFallback?.();
    };
  }, [update]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!renaming || !dialog) return;
    if (!dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }
    const input = renameInputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [renaming]);

  // Track the last focused element outside the toast so dismissing from inside
  // the toast can restore focus to the user's prior location.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (toastRef.current?.contains(target)) return;
      lastFocusOutsideToastRef.current = target;
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => document.removeEventListener("focusin", onFocusIn, true);
  }, []);

  // Keep React state in sync if the toast popover is hidden externally.
  useEffect(() => {
    const el = toastRef.current;
    if (!el) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "closed") {
        setNotice(null);
      }
    };
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, []);

  // Promote active toast to the top layer via Popover API and announce via ariaNotify.
  useEffect(() => {
    const el = toastRef.current;
    if (!el) return;
    if (notice) {
      if (typeof el.showPopover === "function" && !el.matches(":popover-open")) {
        el.showPopover();
      }
      const doc = document as AriaNotifyDocument;
      if ("ariaNotify" in doc && typeof doc.ariaNotify === "function") {
        const announcement = notice.undo ? `${notice.text} Actions available.` : notice.text;
        doc.ariaNotify(announcement, { priority: notice.error ? "high" : "normal" });
      }
    } else if (typeof el.hidePopover === "function" && el.matches(":popover-open")) {
      el.hidePopover();
    }
  }, [notice]);

  const dismissNotice = () => {
    const el = toastRef.current;
    const focusWasInside = Boolean(el && el.contains(document.activeElement));
    showNotice(null);
    if (el && typeof el.hidePopover === "function" && el.matches(":popover-open")) {
      el.hidePopover();
    }
    if (focusWasInside) {
      const prev = lastFocusOutsideToastRef.current;
      if (prev && prev.isConnected) prev.focus();
    }
  };

  const displayedNotice = notice ?? lastNotice;

  return (
    <SessionActionsContext.Provider value={{ pending, archive, rename }}>
      {children}
      <dialog
        ref={dialogRef}
        {...({ closedby: "any" } as unknown as DialogHTMLAttributes<HTMLDialogElement>)}
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
            <Input
              ref={renameInputRef}
              id={renameInputId}
              name="name"
              autoFocus
              autoComplete="off"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
            />
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
        <div
          ref={toastRef}
          id={toastId}
          popover="manual"
          hidden={!supportsPopover && !notice}
          role={displayedNotice?.error ? "alert" : "status"}
          aria-live={supportsAriaNotify ? "off" : undefined}
          className="boxen-toast w-[calc(100%-2rem)] max-w-lg flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-3 text-sm text-foreground shadow-lg"
        >
          {displayedNotice && (
            <>
              <span className="min-w-0 flex-1 break-words">{displayedNotice.text}</span>
              {displayedNotice.undo && (
                <Button size="sm" variant="outline" disabled={pending || !notice} onClick={() => void archive(displayedNotice.undo!, false)}>
                  Undo
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                popoverTarget={toastId}
                popoverTargetAction="hide"
                aria-label="Dismiss notification"
                onClick={dismissNotice}
              >
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
