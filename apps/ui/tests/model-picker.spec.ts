import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/model-picker.html");
  await expect(page.getByRole("button", { name: "Choose model" })).toBeVisible();
});

for (const [provider, modelId, name, level] of [
  ["anthropic", "claude-test", "Claude test", "off"],
  ["openrouter", "vendor/model-test", "Router test", "off"],
  ["github-copilot", "copilot-test", "Copilot test", "low"],
  ["openai", "openai-test", "OpenAI test", "low"],
]) {
  test(`saves ${provider}'s current model and thinking level explicitly`, async ({ page }) => {
    const bodies: unknown[] = [];
    await page.route("**/api/default-agent", async (route) => {
      const agent = route.request().postDataJSON();
      bodies.push(agent);
      await route.fulfill({ json: { providers: [provider], agent } });
    });
    const picker = page.getByRole("button", { name: "Choose model" });
    await picker.click();
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await expect(picker).toContainText(modelId);
    expect(bodies).toEqual([]); // ordinary selection remains Session-only
    await picker.click();
    await page.getByRole("button", { name: level, exact: true }).click();
    const count = await page.getByLabel("Session configuration count").textContent();
    await page.getByRole("button", { name: "Make default for new sessions", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(`${provider}/${modelId} · ${level}`);
    await expect(page.getByRole("status")).toContainText("Existing sessions are unchanged");
    expect(bodies).toEqual([{ model: { provider, modelId }, thinkingLevel: level }]);
    await expect(page.getByLabel("Session configuration count")).toHaveText(count!);
  });
}

test("save failure is visible and retry works; pending saves cannot be duplicated", async ({ page }) => {
  let calls = 0;
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  await page.route("**/api/default-agent", async (route) => {
    if (++calls === 1) {
      started.resolve();
      await release.promise;
      await route.fulfill({ status: 400, json: { error: "Model is no longer available" } });
    } else {
      await route.fulfill({ json: { providers: ["anthropic"], agent: route.request().postDataJSON() } });
    }
  });
  await page.getByRole("button", { name: "Choose model" }).click();
  const save = page.getByRole("button", { name: "Make default for new sessions", exact: true });
  await save.click();
  await started.promise;
  await expect(page.getByRole("button", { name: "Saving default…" })).toBeDisabled();
  release.resolve();
  await expect(page.getByRole("alert")).toHaveText("Model is no longer available");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status")).toContainText("anthropic/claude-test · high");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Session configuration count")).toHaveText("0");
  expect(calls).toBe(2);
});

test("cannot save without a model or open the picker while disconnected", async ({ page }) => {
  await page.getByRole("button", { name: "Clear fixture model" }).click();
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect(page.getByRole("button", { name: "Make default for new sessions", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Disconnect fixture" }).click();
  await expect(page.getByRole("button", { name: "Choose model" })).toBeDisabled();
});
