/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const userDataDir = process.env.FOLDSEEK_AUTH_PROFILE;
if (!userDataDir) throw new Error("FOLDSEEK_AUTH_PROFILE is required");

const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
await fs.mkdir(outputDir, { recursive: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--profile-directory=Default"],
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});

await page.goto("https://portals.to/my-games/web/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(15_000);

const buttons = await page.locator("button:visible").evaluateAll((nodes) =>
  nodes.map((node) => ({ text: node.innerText.trim(), aria: node.getAttribute("aria-label") })),
);
const links = await page.locator("a:visible").evaluateAll((nodes) =>
  nodes.map((node) => ({ text: node.innerText.trim(), href: node.getAttribute("href") })),
);
await page.screenshot({ path: path.join(outputDir, "portals-game-sync-inspect.png"), fullPage: true });
process.stdout.write(
  JSON.stringify(
    {
      title: await page.title(),
      url: page.url(),
      text: (await page.locator("body").innerText()).slice(0, 8_000),
      buttons,
      links,
      errors: errors.slice(0, 50),
    },
    null,
    2,
  ),
);
await context.close();
