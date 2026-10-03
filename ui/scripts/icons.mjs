// npm run icons (requires `npx playwright install chromium`). Reuse the app's
// favicon on an opaque background; the mark fits the maskable safe circle.
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const mark = await readFile(new URL("../public/favicon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size] of [["apple-touch-icon", 180], ["pwa-192", 192], ["pwa-512", 512], ["pwa-maskable-512", 512]]) {
    await page.setContent(`<style>body{margin:0}</style><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512"><rect width="512" height="512" fill="#171717"/>${mark.replace('width="48" height="46"', 'x="128" y="128" width="256" height="256"')}</svg>`);
    await page.locator("svg").first().screenshot({ path: new URL(`../public/${name}.png`, import.meta.url).pathname });
  }
} finally {
  await browser.close();
}
