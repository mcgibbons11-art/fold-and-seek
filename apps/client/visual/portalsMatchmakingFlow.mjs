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
await page.waitForTimeout(30_000);
const frames = page.frames().filter((frame) => /arcade\.portals\.to\/drafts\/editor/.test(frame.url()));
if (frames.length !== 2) throw new Error(`Expected two player frames, found ${frames.length}`);
for (const frame of frames) {
  await frame.getByRole("button", { name: /enter the shop/i }).click();
  await frame.getByRole("button", { name: /^matchmaking$/i }).click();
}
await page.waitForTimeout(2_000);
await frames[0].getByRole("button", { name: /^new room$/i }).click();
await page.waitForTimeout(1_000);
const hostSetup = {
  text: (await frames[0].locator("body").innerText()).slice(0, 8_000),
  inputs: await frames[0].locator("input:visible").evaluateAll((nodes) =>
    nodes.map((node) => ({
      type: node.type,
      name: node.name,
      placeholder: node.placeholder,
      value: node.value,
      aria: node.getAttribute("aria-label"),
    })),
  ),
  buttons: await frames[0].locator("button:visible").evaluateAll((nodes) =>
    nodes.map((node) => ({ text: node.innerText.trim(), disabled: node.hasAttribute("disabled") })),
  ),
};
await page.screenshot({ path: path.join(outputDir, "portals-host-setup.png"), fullPage: false });
await frames[0].getByRole("button", { name: /cancel hosted room/i }).click();
await page.waitForTimeout(1_000);
const afterCancel = {
  text: (await frames[0].locator("body").innerText()).slice(0, 4_000),
  newRoomDisabled: await frames[0].getByRole("button", { name: /^new room$/i }).isDisabled(),
};
process.stdout.write(JSON.stringify({ hostSetup, afterCancel, errors }, null, 2));
await context.close();
