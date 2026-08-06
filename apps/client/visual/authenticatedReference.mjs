/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const userDataDir = process.env.FOLDSEEK_AUTH_PROFILE;
if (!userDataDir) throw new Error("FOLDSEEK_AUTH_PROFILE is required");

const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
const authUrl = process.env.FOLDSEEK_AUTH_URL ?? "https://chatgpt.com/";
const outputName = process.env.FOLDSEEK_AUTH_SCREENSHOT ?? "authenticated-site-check.png";
await fs.mkdir(outputDir, { recursive: true });

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--profile-directory=Default", "--disable-background-networking"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4_000);
await page.screenshot({ path: path.join(outputDir, outputName), fullPage: false });

const pageText = (await page.locator("body").innerText()).slice(0, 3_000);
process.stdout.write(JSON.stringify({ title: await page.title(), url: page.url(), pageText }, null, 2));
await context.close();
