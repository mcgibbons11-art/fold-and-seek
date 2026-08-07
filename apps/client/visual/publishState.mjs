/* global process */
import { chromium } from "@playwright/test";
const context = await chromium.launchPersistentContext(process.env.FOLDSEEK_AUTH_PROFILE, {
  channel: "chrome", headless: true, viewport: { width: 1440, height: 1000 },
  args: ["--profile-directory=Default"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://portals.to/my-games/web/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded", timeout: 60_000,
});
await page.waitForTimeout(6_000);
const tab = page.getByRole("tab", { name: /publish/i }).first();
if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(5_000); }
const body = await page.locator("body").innerText();
console.log("PAGE:", body.replace(/\s+/g, " ").slice(0, 700));
const tabs = await page.getByRole("tab").allInnerTexts().catch(() => []);
const buttons = await page.getByRole("button").allInnerTexts().catch(() => []);
console.log("TABS:", tabs.join(" | "));
console.log("BUTTONS:", buttons.map((b) => b.replace(/\s+/g, " ")).slice(0, 20).join(" | "));
await context.close();
