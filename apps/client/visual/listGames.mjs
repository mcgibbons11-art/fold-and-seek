/* global process */
import { chromium } from "@playwright/test";

const context = await chromium.launchPersistentContext(process.env.FOLDSEEK_AUTH_PROFILE, {
  channel: "chrome", headless: true, viewport: { width: 1440, height: 1000 },
  args: ["--profile-directory=Default"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://portals.to/my-games", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(6_000);
const links = await page.$$eval("a[href*='/my-games/']", (as) =>
  as.map((a) => ({ href: a.getAttribute("href"), text: (a.textContent ?? "").trim().slice(0, 60) }))
     .filter((row) => row.href && row.href.split("/").length > 3));
console.log(JSON.stringify(links.slice(0, 20), null, 1));
await context.close();
