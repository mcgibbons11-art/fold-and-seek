/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const profile = process.env.FOLDSEEK_AUTH_PROFILE;
if (!profile) throw new Error("FOLDSEEK_AUTH_PROFILE is required");

const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
await fs.mkdir(outputDir, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--profile-directory=Default"],
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
const interestingResponses = [];
page.on("console", (message) => {
  if (message.type() === "error" || /refused|fold|seek|iframe|webgl/i.test(message.text())) {
    errors.push(`console:${message.type()}: ${message.text()}`);
  }
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
page.on("response", (response) => {
  const url = response.url();
  if (response.status() >= 400 || /github|index\.html|portals\/assets|fold-and-seek/i.test(url)) {
    interestingResponses.push(`${response.status()} ${url}`);
  }
});

await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(45_000);

const frames = page.frames().map((frame) => ({ name: frame.name(), url: frame.url() }));
const buttons = await page.locator("button:visible").evaluateAll((nodes) =>
  nodes.map((node) => ({ text: node.innerText.trim(), aria: node.getAttribute("aria-label") })),
);
const body = await page.locator("body").innerText();
await page.screenshot({ path: path.join(outputDir, "portals-runtime-smoke.png"), fullPage: false });
process.stdout.write(
  JSON.stringify(
    {
      title: await page.title(),
      url: page.url(),
      body: body.slice(0, 8_000),
      frames,
      buttons,
      errors: errors.slice(0, 100),
      responses: interestingResponses.slice(0, 100),
    },
    null,
    2,
  ),
);
await context.close();
