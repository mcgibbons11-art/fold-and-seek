/* global process */
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${String(e)}`));
const sdkRequests = [];
page.on("request", (r) => {
  if (/_portals|sdk\.js|portals\.to/.test(r.url())) sdkRequests.push(r.url());
});
page.on("response", (r) => {
  if (/_portals|sdk\.js/.test(r.url())) sdkRequests.push(`${String(r.status())} <- ${r.url()}`);
});

await page.goto("http://localhost:5417/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(12_000);

const probe = await page.evaluate(() => ({
  devDeclared: Boolean(window.__PORTALS_DEV__),
  tokenPrefix: window.__PORTALS_DEV__?.token?.slice(0, 5) ?? null,
  hasPortals: typeof window.Portals !== "undefined",
  hasNet: typeof window.Portals?.net !== "undefined",
}));

console.log(JSON.stringify({ probe, sdkRequests: [...new Set(sdkRequests)].slice(0, 6) }, null, 1));
console.log("LOGS:", logs.filter((l) => /portals|sdk|offline/i.test(l)).slice(0, 8).join(" | "));
await browser.close();
