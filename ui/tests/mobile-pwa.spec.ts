import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const sessions = [
  { id: "alpha", name: "Alpha session", createdAt: 1 },
  { id: "beta", name: "Beta session", createdAt: 2 },
];
const snapshot = {
  type: "snapshot",
  entries: Array.from({ length: 12 }, (_, i) => ({
    model: [{ role: "user", content: `Message ${i}: a durable conversation to scroll through.\n` + "More transcript content.\n".repeat(6) }],
  })),
  tools: [],
};

async function mockAPI(page: Page) {
  page.on("pageerror", (error) => { throw error; });
  const state = { hold: false, connections: 0, waiting: [] as WebSocketRoute[] };
  const join = (ws: WebSocketRoute) => {
    ws.send(JSON.stringify({ type: "events", events: [snapshot] }));
    ws.send(JSON.stringify({ type: "ready" }));
  };
  await page.route("**/api/**", (route) => route.fulfill({ json: [] }));
  await page.routeWebSocket("**/api/**", (ws) => {
    const directory = ws.url().includes("/directory/");
    if (!directory) state.connections++;
    ws.onMessage((raw) => {
      const cmd = JSON.parse(raw.toString());
      if (cmd.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (cmd.type !== "sub") return;
      if (directory) {
        ws.send(JSON.stringify({ type: "sessions", sessions }));
      } else {
        ws.send(JSON.stringify({ type: "meta", meta: sessions.find((s) => ws.url().includes(s.id)) }));
        if (state.hold) state.waiting.push(ws);
        else join(ws);
      }
    });
  });
  return { state, release: () => { state.hold = false; state.waiting.splice(0).forEach(join); } };
}
const composer = (page: Page) => page.getByPlaceholder("Message pi…");
async function select(page: Page, name: string) {
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
}
async function controlled(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test.describe("resume works even without service worker support", () => {
test.use({ serviceWorkers: "block" });

test("selection survives reload, home-screen launch, back/forward and another tab", async ({ page, context }) => {
  await mockAPI(page);
  await page.goto("/");
  await select(page, "Alpha session");
  await expect(composer(page)).toBeEnabled();
  await composer(page).fill("unsent draft");
  await page.reload();
  await expect(page).toHaveURL(/session=alpha/);
  await expect(composer(page)).toHaveValue("unsent draft");
  await select(page, "Beta session");
  await expect(composer(page)).toHaveValue("");
  await page.goBack();
  await expect(page).toHaveURL(/session=alpha/);
  await expect(composer(page)).toHaveValue("unsent draft");
  await page.goForward();
  await expect(page).toHaveURL(/session=beta/);

  const other = await context.newPage();
  // A lightweight same-origin tab writes the fallback, as another session
  // picker would. No second Trellis/terminal renderer is needed for this check.
  await other.goto("/manifest.webmanifest");
  await other.evaluate(() => localStorage.setItem("pids.selectedSession", "alpha"));
  await other.close();
  await page.reload(); // this tab's URL wins over the other tab's storage
  await expect(page).toHaveURL(/session=beta/);
  await page.goto("/"); // a new home-screen launch uses the last session
  await expect(page).toHaveURL(/session=beta/);
  expect(await page.locator('script[src*="@vite/client"]').count()).toBe(0);
});

test("foreground reconnect retains transcript, scroll and draft without reloading", async ({ page }) => {
  const api = await mockAPI(page);
  await page.goto("/?session=alpha");
  await expect(composer(page)).toBeEnabled();
  await composer(page).fill("keep this draft");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await viewport.evaluate((el) => { el.scrollTop = 400; });
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(400);
  const before = api.state.connections;
  api.state.hold = true;
  await page.evaluate(() => {
    (window as any).resumeSentinel = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    delete (document as any).visibilityState;
  });
  await expect.poll(() => api.state.connections).toBeGreaterThan(before);
  await expect(composer(page)).toBeDisabled();
  await expect(page.getByText("Message 0:", { exact: false })).toBeAttached();
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(400);
  api.release();
  await expect(composer(page)).toBeEnabled();
  await expect(composer(page)).toHaveValue("keep this draft");
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(400);
  expect(await page.evaluate(() => (window as any).resumeSentinel)).toBe(true);
});

});

test("install metadata and offline shell, without API caching or API navigation fallback", async ({ page, context }) => {
  const api = await mockAPI(page);
  await page.goto("/?session=alpha");
  await expect(composer(page)).toBeEnabled();
  await controlled(page);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    expect(response.headers()["content-type"]).toBe("image/png");
    const png = await response.body();
    const size = Number(icon.sizes.split("x")[0]);
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
  // Remove mocks before offline checks so only the actual worker/network runs.
  await page.unroute("**/api/**");
  api.state.hold = true;
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Offline");
  await expect(page.getByText("Connecting to session…")).toBeVisible();
  await expect(page).toHaveURL(/session=alpha/);
  await expect(composer(page)).not.toBeAttached();
  const apiResult = await page.evaluate(async () => {
    try { return await (await fetch("/api/sessions")).text(); } catch { return "network error"; }
  });
  expect(apiResult).toBe("network error");
  const cached = await page.evaluate(async () => {
    const entries = await Promise.all((await caches.keys()).map(async (key) => (await (await caches.open(key)).keys()).map((r) => r.url)));
    return entries.flat();
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.some((url) => new URL(url).pathname.startsWith("/api"))).toBe(false);
  // A navigation to an API endpoint must not receive the cached app HTML.
  const apiPage = await context.newPage();
  await expect(apiPage.goto("http://127.0.0.1:4176/api/sessions")).rejects.toThrow();
});

test("a waiting update never reloads until accepted, then restores session and draft", async ({ page }) => {
  await mockAPI(page);
  await page.goto("/?session=alpha");
  await controlled(page);
  await expect(composer(page)).toBeEnabled();
  await composer(page).fill("survive update");
  await page.evaluate(() => { (window as any).updateSentinel = true; });
  const path = new URL("../dist/sw.js", import.meta.url);
  const original = await readFile(path, "utf8");
  try {
    await writeFile(path, original + "\n// test update\n");
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
    await expect(page.getByText("An app update is ready.")).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).updateSentinel)).toBe(true);
    await page.getByRole("button", { name: "Reload to update" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).updateSentinel)).toBeUndefined();
    await expect(page).toHaveURL(/session=alpha/);
    await expect(composer(page)).toHaveValue("survive update");
  } finally {
    await writeFile(path, original);
  }
});
