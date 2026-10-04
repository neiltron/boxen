// Browser smoke test with HTTP/WS fixtures; no celld, model, or sandbox needed.
// pnpm run build && pnpm exec playwright install chromium && pnpm run check:sessions
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({ preview: { host: "127.0.0.1", port: 5177, strictPort: true } });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const sessions = [{ id: "abc-123", name: "Investigate reconnects", cwd: "/workspace", status: "running", createdAt: 1, lastActivity: 1, archivedAt: null, metadataRevision: 0 }];
  const sockets = new Set();
  const errors = [];
  let failNext = false, sessionSubscriptions = 0;
  const snapshot = () => ({ type: "sessions", sessions, auth: { providers: [], agent: {} } });
  const broadcast = () => {
    for (const ws of sockets) {
      if (ws.url().endsWith("/directory/ws")) ws.send(JSON.stringify(snapshot()));
      else ws.send(JSON.stringify({ type: "meta", meta: sessions[0] }));
    }
  };
  await context.routeWebSocket("**/api/**", (ws) => {
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "sub") return;
      if (ws.url().endsWith("/directory/ws")) ws.send(JSON.stringify(snapshot()));
      else {
        sessionSubscriptions++;
        ws.send(JSON.stringify({ type: "meta", meta: sessions[0] }));
        ws.send(JSON.stringify({ type: "events", events: [{ type: "run_start" }] }));
        ws.send(JSON.stringify({ type: "ready" }));
      }
    });
  });
  await context.route("**/api/**", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      if (failNext) {
        failNext = false;
        return route.fulfill({ status: 503, json: { error: "Try again: simulated outage" } });
      }
      const patch = req.postDataJSON();
      sessions[0].metadataRevision++;
      if ("name" in patch) sessions[0].name = patch.name;
      if ("archived" in patch) sessions[0].archivedAt = patch.archived ? Date.now() : null;
      broadcast();
      return route.fulfill({ json: sessions[0] });
    }
    return route.fulfill({ json: req.url().endsWith("/diff") ? { repo: false, patch: "" } : [] });
  });
  const page = await context.newPage();
  const other = await context.newPage();
  for (const tab of [page, other]) {
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto("http://127.0.0.1:5177");
    await tab.getByRole("button", { name: "Actions for Investigate reconnects", exact: true }).waitFor();
  }

  // Rename an unopened session through the prompt: blank is ignored, a failure
  // is reported, and a retry succeeds.
  const rename = async (tab, menu, value) => {
    tab.once("dialog", (dialog) => {
      assert.equal(dialog.defaultValue(), sessions[0].name);
      void dialog.accept(value);
    });
    await menu.getByRole("button", { name: `Actions for ${sessions[0].name}`, exact: true }).click();
    await tab.getByRole("menuitem", { name: "Rename", exact: true }).click();
  };
  const revision = sessions[0].metadataRevision;
  await rename(page, page.locator("nav"), "   ");
  failNext = true;
  await rename(page, page.locator("nav"), "Renamed session");
  await page.getByRole("alert").filter({ hasText: "simulated outage" }).waitFor();
  assert.equal(sessions[0].metadataRevision, revision, "blank and failed renames change nothing");
  await rename(page, page.locator("nav"), "Renamed session");
  await other.getByRole("button", { name: "Actions for Renamed session", exact: true }).waitFor();
  assert.equal(sessionSubscriptions, 0, "sidebar rename does not connect to the agent");

  // Open it, preserve the composer draft across archive/filter/restore, and
  // verify a second browser sees the same list changes.
  await page.locator("nav").getByRole("button", { name: /^Renamed session/ }).click();
  const draft = page.getByPlaceholder("Steer the running agent…");
  await draft.fill("Keep my unsent draft");

  // Exercise the actual SessionView ref wiring, not just the Trellis fixture:
  // a selected row still owns focus until a global shortcut enters the chat.
  await page.locator("nav").getByRole("button", { name: /^Renamed session/ }).focus();
  await page.keyboard.press("Control+Alt+k");
  await page.waitForFunction(() => document.activeElement?.matches("[data-chat-composer]"));
  await page.keyboard.press("Control+Alt+k");
  await page.waitForFunction(() => document.activeElement?.matches('[role="tab"]'));
  await page.keyboard.press("Control+Alt+k");
  await page.waitForFunction(() => document.activeElement?.matches("[data-chat-composer]"));
  const panelToggle = page.getByRole("button", { name: "Show or hide the panel", exact: true });
  await panelToggle.click();
  await page.getByRole("tab", { name: "Artifacts", exact: true }).waitFor({ state: "hidden" });
  await panelToggle.click();
  await page.getByRole("tab", { name: "Artifacts", exact: true }).waitFor();
  assert.equal(await page.getByRole("tablist").count(), 1, "sidebar restores as one group");

  for (const ws of sockets) {
    if (!ws.url().endsWith("/directory/ws")) ws.send(JSON.stringify({ type: "meta", meta: { ...sessions[0], name: "Stale title", metadataRevision: 0 } }));
  }

  await page.locator("header").getByRole("button", { name: "Actions for Renamed session", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page.locator("header").getByText("Archived", { exact: true }).waitFor();
  await other.locator("nav").getByRole("button", { name: "Actions for Renamed session", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await draft.inputValue(), "Keep my unsent draft");
  assert.equal(sessionSubscriptions, 1, "archiving does not remount the selected view");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.locator("header").getByText("Archived", { exact: true }).waitFor({ state: "hidden" });
  await other.getByRole("button", { name: "Actions for Renamed session", exact: true }).waitFor();

  // Archive again, browse archived rows, then restore from the header.
  await page.locator("header").getByRole("button", { name: "Actions for Renamed session", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page.locator("header").getByText("Archived", { exact: true }).waitFor();
  await other.getByRole("button", { name: "Archived", exact: true }).click();
  await other.getByRole("button", { name: "Actions for Renamed session", exact: true }).click();
  await other.getByRole("menuitem", { name: "Restore", exact: true }).waitFor();
  await other.keyboard.press("Escape");
  await page.locator("header").getByRole("button", { name: "Actions for Renamed session", exact: true }).click();
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await other.getByText("No archived sessions", { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), "Keep my unsent draft");

  // Dismissing the prompt cancels; keyboard can reach menus; touch layout retains them.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.locator("header").getByRole("button", { name: "Actions for Renamed session", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  assert.equal(sessions[0].name, "Renamed session");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("header").getByRole("button", { name: "Actions for Renamed session", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Artifacts", exact: true }).waitFor({ state: "hidden" });
  await panelToggle.click();
  await page.getByRole("tab", { name: "Artifacts", exact: true }).waitFor();
  await page.getByPlaceholder("Steer the running agent…").fill("Mobile draft rerender");
  await page.getByRole("tab", { name: "Artifacts", exact: true }).waitFor();
  assert.equal(await page.getByRole("tablist").count(), 1, "fresh mobile panel stays open across rerenders");
  assert.deepEqual(errors, [], "no uncaught browser errors");
  console.log("session-actions.check ok (two browsers, rename/archive/undo/restore, failures, draft, keyboard/mobile)");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
