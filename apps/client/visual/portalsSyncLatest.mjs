/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const profile = process.env.FOLDSEEK_AUTH_PROFILE;
const expectedCommit = process.env.FOLDSEEK_EXPECTED_COMMIT;
if (!profile || !expectedCommit) throw new Error("profile and expected commit are required");

const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
await fs.mkdir(outputDir, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--profile-directory=Default"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://portals.to/my-games/web/gde550c363c6e3710963a93df", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();

await page.getByRole("button", { name: "sync latest from GitHub" }).waitFor({ timeout: 45_000 });
let body = await page.locator("body").innerText();
let triggered = false;
if (!body.includes(expectedCommit)) {
  await page.getByRole("button", { name: "sync latest from GitHub" }).click();
  const confirm = page.getByRole("button", { name: "replace and sync" });
  await confirm.waitFor({ timeout: 10_000 });
  await confirm.click();
  triggered = true;
}

const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  await page.waitForTimeout(2_000);
  body = await page.locator("body").innerText();
  if (body.includes(expectedCommit)) break;
}

await page.screenshot({ path: path.join(outputDir, "portals-game-synced.png"), fullPage: false });
const result = {
  triggered,
  expectedCommit,
  synced: body.includes(expectedCommit),
  relevantText: body
    .split("\n")
    .filter((line) => /last commit|sync|build|error|failed|b91cf1c/i.test(line))
    .slice(0, 50),
};
process.stdout.write(JSON.stringify(result, null, 2));
await context.close();
if (!result.synced) process.exitCode = 2;
