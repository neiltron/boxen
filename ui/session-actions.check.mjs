// Browser smoke test with HTTP/WS fixtures; no celld, model, or sandbox needed.
// npm run build && npx playwright install chromium && npm run check:sessions
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

  // Rename an unopened session, including blank input, failure/retry, and Enter.
  await page.getByRole("button", { name: "Actions for Investigate reconnects", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.waitFor();
  assert.equal(await name.evaluate((el) => el.selectionEnd - el.selectionStart), "Investigate reconnects".length);
  await name.fill("   ");
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  await name.fill("Renamed session");
  failNext = true;
  await name.press("Enter");
  await page.getByRole("alert").filter({ hasText: "simulated outage" }).waitFor();
  await name.press("Enter");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await other.getByRole("button", { name: "Actions for Renamed session", exact: true }).waitFor();
  assert.equal(sessionSubscriptions, 0, "sidebar rename does not connect to the agent");

  // Open it, preserve the composer draft across archive/filter/restore, and
  // verify a second browser sees the same list changes.
  await page.locator("nav").getByRole("button", { name: /^Renamed session/ }).click();
  const draft = page.getByPlaceholder("Steer the running agent…");
  await draft.fill("Keep my unsent draft");
  for (const ws of sockets) {
    if (!ws.url().endsWith("/directory/ws")) ws.send(JSON.stringify({ type: "meta", meta: { ...sessions[0], name: "Stale title", metadataRevision: 0 } }));
  }

  await page.locator("header").getByRole("button", { name: "Actions for Renamed session", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Archived session: restore" }).waitFor();
  await other.locator("nav").getByRole("button", { name: "Actions for Renamed session", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await draft.inputValue(), "Keep my unsent draft");
  assert.equal(sessionSubscriptions, 1, "archiving does not remount the selected view");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Archived session: restore" }).waitFor({ state: "hidden" });
  await other.getByRole("button", { name: "Actions for Renamed session", exact: true }).waitFor();

  // Archive again, browse archived rows, then restore from the header.
  await page.locator("header").getByRole("button", { name: "Actions for Renamed session", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Archived session: restore" }).waitFor();
  await other.getByRole("button", { name: "Archived", exact: true }).click();
  await other.getByRole("button", { name: "Actions for Renamed session", exact: true }).click();
  await other.getByRole("menuitem", { name: "Restore", exact: true }).waitFor();
  await other.keyboard.press("Escape");
  await page.getByRole("button", { name: "Archived session: restore" }).click();
  await other.getByText("No archived sessions", { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), "Keep my unsent draft");

  // Escape cancels rename, keyboard can reach menus, touch layout retains them.
  await page.locator("header").getByRole("button", { name: "Actions for Renamed session", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Do not save");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(sessions[0].name, "Renamed session");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("header").getByRole("button", { name: "Actions for Renamed session", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, [], "no uncaught browser errors");
  console.log("session-actions.check ok (two browsers, rename/archive/undo/restore, failures, draft, keyboard/mobile)");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
