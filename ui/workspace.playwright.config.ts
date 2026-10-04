import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "workspace.spec.ts",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:5187", browserName: "chromium" },
  webServer: {
    command: "npm exec vite -- --config tests/vite.config.ts",
    url: "http://127.0.0.1:5187/tests/workspace.html",
    reuseExistingServer: !process.env.CI,
  },
});
