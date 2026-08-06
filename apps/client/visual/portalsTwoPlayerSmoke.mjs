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
  viewport: { width: 1600, height: 1000 },
  args: ["--profile-directory=Default"],
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});

await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(30_000);

const gameFrames = page.frames().filter((frame) => /arcade\.portals\.to\/drafts\/editor/.test(frame.url()));
if (gameFrames.length !== 2) throw new Error(`Expected two Portals player frames, found ${gameFrames.length}`);

for (const frame of gameFrames) {
  await frame.getByRole("button", { name: /enter the shop/i }).click();
}
await page.waitForTimeout(2_000);
await page.screenshot({ path: path.join(outputDir, "portals-two-player-menu.png"), fullPage: false });

const snapshots = [];
for (const [index, frame] of gameFrames.entries()) {
  snapshots.push({
    player: index + 1,
    text: (await frame.locator("body").innerText()).slice(0, 6_000),
    buttons: await frame.locator("button:visible").evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.innerText.trim(),
        aria: node.getAttribute("aria-label"),
        pressed: node.getAttribute("aria-pressed"),
        disabled: node.hasAttribute("disabled"),
      })),
    ),
  });
}

for (const frame of gameFrames) {
  const matchmaking = frame.getByRole("button", { name: /matchmaking/i }).first();
  if (await matchmaking.isVisible().catch(() => false)) await matchmaking.click();
}
await page.waitForTimeout(3_000);
await page.screenshot({ path: path.join(outputDir, "portals-two-player-matchmaking.png"), fullPage: false });

const matchmaking = [];
for (const [index, frame] of gameFrames.entries()) {
  matchmaking.push({
    player: index + 1,
    text: (await frame.locator("body").innerText()).slice(0, 8_000),
    buttons: await frame.locator("button:visible").evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.innerText.trim(),
        aria: node.getAttribute("aria-label"),
        pressed: node.getAttribute("aria-pressed"),
        disabled: node.hasAttribute("disabled"),
      })),
    ),
  });
}

process.stdout.write(JSON.stringify({ snapshots, matchmaking, errors: errors.slice(0, 100) }, null, 2));
await context.close();
