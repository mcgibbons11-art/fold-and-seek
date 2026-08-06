/* global process */

import { chromium } from "@playwright/test";
import path from "node:path";

const userDataDir = process.env.FOLDSEEK_AUTH_PROFILE;
const query = process.env.FOLDSEEK_MIXAMO_QUERY ?? "Running";
if (!userDataDir) throw new Error("FOLDSEEK_AUTH_PROFILE is required");

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome", headless: true, viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
  args: ["--profile-directory=Default", "--disable-background-networking"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://www.mixamo.com/#/?page=1&type=Motion%2CMotionPack", {
  waitUntil: "domcontentloaded", timeout: 60_000,
});
await page.waitForTimeout(4_000);
const search = page.locator('input[type="search"]');
await search.fill(query);
await search.press("Enter");
await page.waitForTimeout(5_000);
const text = (await page.locator("body").innerText()).slice(0, 8_000);
const cards = await page.locator(".product-card, [class*=product], [class*=motion]").evaluateAll((nodes) => nodes.map((node) => ({
  className: typeof node.className === "string" ? node.className : "",
  text: node.textContent?.trim().slice(0, 180) ?? "",
})).filter((item) => item.text));
await page.screenshot({ path: path.resolve(process.cwd(), "../.playwright-mcp/mixamo-animation-search.png") });
process.stdout.write(JSON.stringify({ text, cards: cards.slice(0, 80) }, null, 2));
await context.close();
