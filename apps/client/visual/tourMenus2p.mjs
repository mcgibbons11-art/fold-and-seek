/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Full menu tour in the Portals editor's two-player view (2026-08-05 QA).
 * Walks every menu screen in both panes - command menu, how to play, profile,
 * settings, matchmaking browser, custom room pane - snapshotting text, visible
 * buttons and a screenshot at each beat, and collecting every console error.
 * Round play is covered by tourRound2p.mjs; this script never starts a round.
 */

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

const report = { steps: [], errors };
const shot = (name) => page.screenshot({ path: path.join(outputDir, name) });

async function snap(frame, player, step) {
  const text = (await frame.locator("body").innerText().catch(() => "")).slice(0, 4_000);
  const buttons = await frame
    .locator("button:visible")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.innerText.trim().slice(0, 60),
        disabled: node.hasAttribute("disabled"),
      })),
    )
    .catch(() => []);
  report.steps.push({ step, player, text: text.split("\n").slice(0, 30), buttons });
}

async function clickIf(frame, name, timeout = 4_000) {
  const button = frame.getByRole("button", { name }).first();
  try {
    await button.waitFor({ timeout });
    await button.click();
    return true;
  } catch {
    return false;
  }
}

await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(30_000);

const frames = page.frames().filter((frame) => /arcade\.portals\.to\/drafts\/editor/.test(frame.url()));
report.paneCount = frames.length;
if (frames.length === 0) throw new Error("no Portals player frames");

for (const frame of frames) await clickIf(frame, /enter the shop/i, 45_000);
await page.waitForTimeout(2_500);
await shot("tour-menu-01-command.png");
for (const [index, frame] of frames.entries()) await snap(frame, index + 1, "command-menu");

// How to play, in pane 1; back out again.
const p1 = frames[0];
await clickIf(p1, /how to play/i);
await page.waitForTimeout(1_200);
await shot("tour-menu-02-howtoplay.png");
await snap(p1, 1, "how-to-play");
await clickIf(p1, /back|close|command/i);
await page.waitForTimeout(800);

// Profile & history.
await clickIf(p1, /profile/i);
await page.waitForTimeout(1_200);
await shot("tour-menu-03-profile.png");
await snap(p1, 1, "profile");
await clickIf(p1, /back|close|command/i);
await page.waitForTimeout(800);

// Settings.
await clickIf(p1, /settings/i);
await page.waitForTimeout(1_200);
await shot("tour-menu-04-settings.png");
await snap(p1, 1, "settings");
await clickIf(p1, /back|close|command/i);
await page.waitForTimeout(800);

// Start game -> matchmaking browser (both panes, so pane 2's empty state and
// pane 1's room list can be compared later by tourRound2p).
for (const [index, frame] of frames.entries()) {
  await clickIf(frame, /start game/i);
  await page.waitForTimeout(1_500);
  await snap(frame, index + 1, "start-pane");
}
await shot("tour-menu-05-start.png");

for (const [index, frame] of frames.entries()) {
  await clickIf(frame, /matchmaking|find a lobby/i);
  await page.waitForTimeout(2_000);
  await snap(frame, index + 1, "matchmaking");
}
await shot("tour-menu-06-matchmaking.png");

// Custom room and training pane.
for (const [index, frame] of frames.entries()) {
  await clickIf(frame, /custom room and training/i);
  await page.waitForTimeout(1_500);
  await snap(frame, index + 1, "custom-room");
}
await shot("tour-menu-07-custom.png");

process.stdout.write(JSON.stringify(report, null, 2));
await context.close();
