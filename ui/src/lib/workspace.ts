import type { LayoutNode, WorkspaceHandle } from "@danfessler/trellis";

// Clear layouts fragmented into floating panels by the old per-view hide loop.
export const WORKSPACE_LAYOUT_VERSION = 2;

export function restorePanels(workspace: WorkspaceHandle, viewIds: ReadonlySet<string>) {
  const hidden = workspace.getSnapshot().hidden.filter((h) => h.views.some((v) => viewIds.has(v.id)));
  // Undo hides in reverse order so docking targets exist before their neighbours.
  for (const panel of hidden.toReversed()) workspace.restore(panel.panelId);
  return hidden.length > 0;
}

export function togglePanels(workspace: WorkspaceHandle, viewIds: ReadonlySet<string>) {
  if (restorePanels(workspace, viewIds)) return;
  const snap = workspace.getSnapshot();
  // hide(viewId) detaches a single tab. Hide each containing panel once instead.
  const panels = new Set(snap.views.filter((v) => viewIds.has(v.id)).map((v) => v.panelId));
  const chatPanel = snap.views.find((v) => v.id === "chat")?.panelId;
  // Deepest first: a sibling split used as a restore target would otherwise
  // disappear when its children are hidden. Restoring creates new split IDs.
  const depths = new Map<string, number>();
  const visit = (node: LayoutNode | null | undefined, depth: number) => {
    if (!node) return;
    depths.set(node.id, depth);
    if (node.kind === "split") node.children.forEach((child) => visit(child, depth + 1));
    if (node.kind === "stage") visit(node.child, depth + 1);
  };
  visit(snap.document.root, 0);
  const ordered = [...panels].sort((a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0));
  for (const panelId of ordered) {
    // Docking a sidebar tab into chat must never make chat disappear.
    if (panelId !== chatPanel) workspace.hide(panelId);
  }
}

// Only the selected session installs this listener; its ref cleanup removes it
// when switching sessions or changing between desktop and mobile workspaces.
export function bindPanelShortcuts(workspace: WorkspaceHandle) {
  const doc = workspace.element.ownerDocument;
  const win = doc.defaultView!;
  let focusFrame: number | undefined;
  const focusChat = () => {
    workspace.focus("chat");
    if (focusFrame !== undefined) win.cancelAnimationFrame(focusFrame);
    // Trellis schedules DOM focus into the first control (our sidebar button).
    // Run after it so chat's hidden tab is replaced by actual composer focus.
    focusFrame = win.requestAnimationFrame(() => {
      focusFrame = undefined;
      if (workspace.getSnapshot().focusedView !== "chat") return;
      workspace.element.querySelector<HTMLTextAreaElement>("[data-chat-composer]:not(:disabled)")?.focus({ preventScroll: true });
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph")) return;
    if (workspace.getSnapshot().dragging) return;
    // Don't escape a focus-trapped dialog (rename, providers, mobile drawer, etc.).
    if (doc.activeElement?.closest('[role="dialog"], [role="alertdialog"], dialog[open]')) return;
    const inside = workspace.element.contains(doc.activeElement);
    // Keep the browser's F6 behaviour outside the workspace. Modified J/K are
    // app-wide: from the session list, either one enters chat before cycling.
    const f6 = inside && event.key === "F6" && !event.ctrlKey && !event.metaKey && !event.altKey;
    const modified = event.altKey && (event.ctrlKey !== event.metaKey) && !event.shiftKey;
    // Option changes event.key on macOS (J becomes ∆); prefer the physical code.
    const key = (event.code || event.key).replace(/^Key/, "").toLowerCase();
    if (!f6 && !(modified && (key === "j" || key === "k"))) return;
    event.preventDefault();
    // In particular, don't also send handled shortcuts to the terminal's shell.
    event.stopPropagation();
    if (!inside) { focusChat(); return; }
    workspace.run((f6 ? event.shiftKey : key === "k") ? "panel.previous" : "panel.next");
    if (workspace.getSnapshot().focusedView === "chat") focusChat();
  };
  doc.addEventListener("keydown", onKeyDown, true);
  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    if (focusFrame !== undefined) win.cancelAnimationFrame(focusFrame);
  };
}
