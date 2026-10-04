import { expect, test } from "@playwright/test";
import type {} from "./workspace.fixture";

const composer = "[data-chat-composer]";
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/workspace.html");
  await expect(page.locator(composer)).toBeVisible();
});

for (const key of ["j", "k"]) {
  test(`${key}: session list → composer → sidebar → composer`, async ({ page }) => {
    await page.locator("#session").click();
    await page.keyboard.press(`Control+Alt+${key}`);
    await expect(page.locator(composer)).toBeFocused();
    await page.keyboard.press(`Control+Alt+${key}`);
    await expect(page.getByRole("tab", { name: "preview", exact: true })).toBeFocused();
    await page.keyboard.press(`Control+Alt+${key}`);
    await expect(page.locator(composer)).toBeFocused();
  });
}

test("F6 works from composer but remains a browser shortcut outside workspace", async ({ page }) => {
  const outsideHandled = await page.locator("#session").evaluate((el) => {
    el.focus();
    const event = new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(outsideHandled).toBe(false);
  await page.locator(composer).focus();
  await page.keyboard.press("F6");
  await expect(page.getByRole("tab", { name: "preview", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+F6");
  await expect(page.locator(composer)).toBeFocused();
});

test("forward and backward follow opposite orders with three panels", async ({ page }) => {
  await page.evaluate(() => window.harness.workspace.dock("events", { beside: "sidebar", edge: "bottom" }));
  await page.locator(composer).focus();
  await page.keyboard.press("Control+Alt+k");
  await expect(page.getByRole("tab", { name: "events", exact: true })).toBeFocused();
  await page.keyboard.press("Control+Alt+j");
  await expect(page.locator(composer)).toBeFocused();
  await page.keyboard.press("Control+Alt+j");
  await expect(page.getByRole("tab", { name: "preview", exact: true })).toBeFocused();
});

test("macOS Option characters use the physical J/K keys", async ({ page }) => {
  await page.locator("#session").focus();
  const press = (key: string, code: string) => page.evaluate(({ key, code }) => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", {
      key, code, metaKey: true, altKey: true, bubbles: true, cancelable: true,
    }));
  }, { key, code });
  await press("∆", "KeyJ");
  await expect(page.locator(composer)).toBeFocused();
  await press("∆", "KeyJ");
  await expect(page.getByRole("tab", { name: "preview", exact: true })).toBeFocused();
  await press("˚", "KeyK");
  await expect(page.locator(composer)).toBeFocused();
});

for (const axis of ["x", "y"] as const) {
  test(`${axis}: whole group round trips retain tabs, selection and proportions`, async ({ page }) => {
    const result = await page.evaluate((axis) => {
      const h = window.harness;
      h.setup(axis);
      const before = h.workspace.getDocument().root;
      for (let i = 0; i < 3; i++) {
        h.toggle();
        const hidden = h.workspace.getSnapshot().hidden;
        if (hidden.length !== 1 || hidden[0].views.length !== 5) throw new Error("tabs were detached");
        if (h.workspace.views().find((v) => v.id === "chat")?.placement !== "stage") throw new Error("chat hidden");
        h.toggle();
      }
      return { before, after: h.workspace.getDocument() };
    }, axis);
    expect(result.after.hidden).toEqual([]);
    expect(result.after.floating).toEqual([]);
    // Split IDs are reallocated on restoration; their structure must be unchanged.
    const withoutIds = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => key === "id" ? undefined : v));
    expect(withoutIds(result.after.root)).toEqual(withoutIds(result.before));
  });
}

test("nested groups restore without floating, including programmatic opening", async ({ page }) => {
  const result = await page.evaluate(() => {
    const h = window.harness;
    h.workspace.dock("events", { beside: "sidebar", edge: "bottom", share: 0.3 });
    const eventPanel = h.workspace.views().find((v) => v.id === "events")!.panelId;
    h.workspace.dock("terminal", { beside: eventPanel, edge: "right", share: 0.4 });
    const before = h.workspace.getDocument().root;
    for (let i = 0; i < 3; i++) {
      h.toggle();
      if (h.workspace.getSnapshot().hidden.length !== 3) throw new Error("expected three hidden groups");
      if (i === 2) h.restore(); else h.toggle();
      if (h.workspace.getDocument().floating.length) throw new Error("restored as floating windows");
    }
    return { before, after: h.workspace.getDocument().root };
  });
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) =>
    key === "id" ? undefined : typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v));
  expect(normalize(result.after)).toEqual(normalize(result.before));
});

test("partially hidden panels restore; chat is never hidden or resurrects sidebar on cycling", async ({ page }) => {
  await page.evaluate(() => {
    const h = window.harness;
    h.workspace.dock("events", { beside: "sidebar", edge: "bottom" });
    h.workspace.hide("events");
    h.toggle();
    if (h.workspace.getSnapshot().hidden.length) throw new Error("partial restore failed");
    const chatPanel = h.workspace.views().find((v) => v.id === "chat")!.panelId;
    h.workspace.dock("artifacts", { into: chatPanel });
    h.toggle();
    h.workspace.select("chat");
  });
  await page.locator("#session").focus();
  await page.keyboard.press("Control+Alt+k");
  await expect(page.locator(composer)).toBeFocused();
  await page.keyboard.press("Control+Alt+k");
  await expect(page.locator(composer)).toBeFocused();
  expect(await page.evaluate(() => window.harness.workspace.getSnapshot().hidden.length)).toBe(2);
});

test("typing, IME and dialogs keep their keys; handled shortcuts don't reach terminal-like controls", async ({ page }) => {
  await page.locator(composer).fill("jk");
  expect(await page.locator(composer).inputValue()).toBe("jk");
  const imeHandled = await page.locator(composer).evaluate((el) => {
    el.focus();
    const event = new KeyboardEvent("keydown", { key: "j", ctrlKey: true, altKey: true, isComposing: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(imeHandled).toBe(false);
  await page.evaluate(() => document.querySelector("dialog")!.showModal());
  await page.keyboard.press("Control+Alt+k");
  await expect(page.getByRole("textbox", { name: "Rename session" })).toBeFocused();
  await page.evaluate(() => document.querySelector("dialog")!.close());
  await page.locator(composer).focus();
  await page.locator(composer).evaluate((el) => el.addEventListener("keydown", () => { el.setAttribute("data-leaked", "true"); }));
  await page.keyboard.press("Control+Alt+j");
  await expect(page.locator(composer)).not.toHaveAttribute("data-leaked");
});

test("session switches rebind once; disposal removes global listener and pending focus", async ({ page }) => {
  await page.evaluate(() => { window.harness.setup(); window.harness.setup("y"); });
  await page.locator("#session").focus();
  await page.keyboard.press("Control+Alt+k");
  await expect(page.locator(composer)).toBeFocused();
  await page.keyboard.press("Control+Alt+k");
  await expect(page.getByRole("tab", { name: "preview", exact: true })).toBeFocused();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("#session")!.focus();
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, bubbles: true }));
    window.harness.dispose();
  });
  const handled = await page.locator("#session").evaluate((el) => {
    el.focus();
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(handled).toBe(false);
  await expect(page.locator("#session")).toBeFocused();
});
