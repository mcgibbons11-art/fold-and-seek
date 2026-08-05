/* global process */

import { chromium } from "@playwright/test";
import path from "node:path";

/** Dumps the Portals game-settings page state when the sync flow stalls. */

const profile = process.env.FOLDSEEK_AUTH_PROFILE;
if (!profile) throw new Error("FOLDSEEK_AUTH_PROFILE is required");

const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--profile-directory=Default"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://portals.to/my-games/web/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
await page.waitForTimeout(8_000);
// The platform's new onboarding path choice is a UI preference, safe to
// answer. The purchase/waiver dialog is NOT ours to accept; only observe.
const create = page.getByText("I want to create", { exact: false }).first();
if (await create.isVisible().catch(() => false)) {
  await create.click();
  await page.waitForTimeout(600);
  const cont = page.getByRole("button", { name: /continue/i }).first();
  if (await cont.isVisible().catch(() => false)) await cont.click();
  await page.waitForTimeout(4_000);
}
const text = await page.locator("body").innerText();
process.stdout.write(
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 50)
    .join(" | "),
);
await page.screenshot({ path: path.resolve(process.cwd(), "../.playwright-mcp/sync-page-state.png") });
await context.close();
