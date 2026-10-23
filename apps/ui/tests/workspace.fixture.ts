import { createWorkspace, layout, type WorkspaceHandle } from "@danfessler/trellis";
import "@danfessler/trellis/style.css";
import { bindPanelShortcuts, restorePanels, togglePanels } from "../src/lib/workspace";

const ids = ["artifacts", "changes", "timeline", "preview", "terminal", "events"]; // PANEL_VIEWS' order
const sidebar = new Set(ids);
let workspace: WorkspaceHandle;
let unbind: (() => void) | undefined;

function dispose() {
  unbind?.();
  workspace?.destroy();
}
function setup(axis: "x" | "y" = "x") {
  dispose();
  workspace = createWorkspace(document.querySelector<HTMLElement>("#workspace")!, {
    types: {
      chat: { tabbar: "never", closable: false },
      ...Object.fromEntries(ids.map((id) => [id, { title: id, closable: false }])),
    },
    floating: false,
    navigation: false,
    motion: "reduced",
    defaultLayout: layout.split(axis, [
      layout.stage(layout.view("chat", { id: "chat" })),
      layout.panel({ id: "sidebar", selected: ids.indexOf("preview") }, ...ids.map((id) => layout.view(id, { id }))),
    ], { weights: [3, 2] }),
  });
  const chat = workspace.surfaces().find((s) => s.view.id === "chat")!;
  // Like ChatView: controls before the composer, and no visible chat tab.
  chat.content.innerHTML = '<button>Chat toolbar</button><textarea data-chat-composer></textarea>';
  unbind = bindPanelShortcuts(workspace);
}

window.harness = {
  setup,
  dispose,
  get workspace() { return workspace; },
  toggle: () => togglePanels(workspace, sidebar),
  restore: () => restorePanels(workspace, sidebar),
  unbind: () => unbind?.(),
};
setup();

declare global {
  interface Window {
    harness: {
      setup(axis?: "x" | "y"): void;
      dispose(): void;
      workspace: WorkspaceHandle;
      toggle(): void;
      restore(): boolean;
      unbind(): void;
    };
  }
}
