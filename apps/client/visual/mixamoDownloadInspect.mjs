/* global process */

import { chromium } from "@playwright/test";
import path from "node:path";

const profile = process.env.FOLDSEEK_AUTH_PROFILE;
if (!profile) throw new Error("FOLDSEEK_AUTH_PROFILE is required");
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome", headless: true, viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  args: ["--profile-directory=Default", "--disable-background-networking"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://www.mixamo.com/#/?page=1&type=Motion%2CMotionPack", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4_000);
const search = page.locator('input[type="search"]');
await search.fill("Running");
await search.press("Enter");
await page.waitForTimeout(5_000);
await page.locator(".product-animation").filter({ hasText: "Description: Running With Intention" }).first().click();
await page.waitForTimeout(6_000);
await page.getByRole("button", { name: "DOWNLOAD" }).click();
await page.waitForTimeout(2_000);
const selects = await page.locator("select").evaluateAll((nodes) => nodes.map((node) => ({
  value: node.value,
  options: [...node.options].map((option) => ({ text: option.text, value: option.value, selected: option.selected })),
})));
const buttons = await page.locator("button").evaluateAll((nodes) => nodes.map((node) => node.innerText.trim()).filter(Boolean));
const text = (await page.locator("body").innerText()).slice(-3_500);
await page.screenshot({ path: path.resolve(process.cwd(), "../.playwright-mcp/mixamo-download-dialog.png") });
process.stdout.write(JSON.stringify({ text, buttons, selects }, null, 2));
await context.close();
