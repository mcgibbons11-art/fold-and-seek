/* global process */

import { chromium } from "@playwright/test";
import path from "node:path";

const userDataDir = process.env.FOLDSEEK_AUTH_PROFILE;
const uploadPath = process.env.FOLDSEEK_MIXAMO_UPLOAD;
if (!userDataDir || !uploadPath) throw new Error("profile and upload path are required");

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
  args: ["--profile-directory=Default", "--disable-background-networking"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://www.mixamo.com/#/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4_000);
await page.getByRole("button", { name: "UPLOAD CHARACTER" }).click();
await page.waitForTimeout(1_000);

const file = page.locator('input[type="file"]');
if ((await file.count()) > 0) {
  await file.setInputFiles(uploadPath);
} else {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByText(/select character file/i).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(uploadPath);
}

await page.waitForTimeout(18_000);
await page.getByRole("button", { name: "NEXT" }).click();
await page.waitForTimeout(4_000);
const text = (await page.locator("body").innerText()).slice(0, 8_000);
const buttons = await page.locator("button").evaluateAll((nodes) => nodes.map((node) => node.innerText.trim()).filter(Boolean));
const markerElements = await page.locator('[class*="marker"], [draggable="true"]').evaluateAll((nodes) => nodes.map((node) => ({
  tag: node.tagName,
  className: typeof node.className === "string" ? node.className : "",
  text: node.textContent?.trim() ?? "",
  draggable: node.getAttribute("draggable"),
  style: node.getAttribute("style"),
  rect: (() => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
})));
await page.screenshot({ path: path.resolve(process.cwd(), "../.playwright-mcp/mixamo-marker-stage.png") });
process.stdout.write(JSON.stringify({ url: page.url(), text, buttons, markerElements }, null, 2));
await context.close();
