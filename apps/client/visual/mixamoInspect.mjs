/* global process */

import { chromium } from "@playwright/test";
import path from "node:path";

const userDataDir = process.env.FOLDSEEK_AUTH_PROFILE;
if (!userDataDir) throw new Error("FOLDSEEK_AUTH_PROFILE is required");

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--profile-directory=Default", "--disable-background-networking"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://www.mixamo.com/#/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(5_000);

const buttons = await page.locator("button").evaluateAll((nodes) =>
  nodes.map((node) => ({ text: node.innerText.trim(), aria: node.getAttribute("aria-label"), title: node.getAttribute("title") })),
);
const inputs = await page.locator("input").evaluateAll((nodes) =>
  nodes.map((node) => ({ type: node.type, placeholder: node.placeholder, aria: node.getAttribute("aria-label") })),
);
const links = await page.locator("a").evaluateAll((nodes) =>
  nodes.map((node) => ({ text: node.innerText.trim(), href: node.getAttribute("href") })).filter((item) => item.text),
);
process.stdout.write(JSON.stringify({ buttons, inputs, links }, null, 2));
await page.screenshot({ path: path.resolve(process.cwd(), "../.playwright-mcp/mixamo-library.png") });
await context.close();
