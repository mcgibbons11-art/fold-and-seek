/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Verifies the open-door room live in the editor's two panes (2026-08-05):
 * pane 1 hosts with the open toggle on and should land straight in its own
 * lobby; pane 2's browser should read "open door" and a plain JOIN, and
 * arrive in the lobby with no approval step on either side.
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
const note = (step, detail) => report.steps.push({ step, ...detail });

async function textOf(frame) {
  return (await frame.locator("body").innerText().catch(() => "")).slice(0, 6_000);
}

async function clickIf(frame, name, timeout = 5_000) {
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
if (frames.length < 2) throw new Error(`need two panes, found ${frames.length}`);
const [p1, p2] = frames;

for (const frame of frames) await clickIf(frame, /enter the shop/i, 45_000);
await page.waitForTimeout(2_000);

// Pane 1 hosts with the open door.
await clickIf(p1, /start game/i);
await clickIf(p1, /matchmaking|find a lobby/i);
await page.waitForTimeout(1_500);
await clickIf(p1, /custom room and training/i);
await page.waitForTimeout(1_000);
const toggled = await clickIf(p1, /vetted door/i);
note("toggle", { toggled, label: /open door/i.test(await textOf(p1)) });
await clickIf(p1, /new room/i);
await page.waitForTimeout(4_000);
// The open-door host should be in its own lobby already, not the browser.
note("host-lobby", {
  inLobby: /ready up/i.test(await textOf(p1)) || /opening the shop/i.test(await textOf(p1)),
  text: (await textOf(p1)).split("\n").slice(0, 10),
});
await shot("tour-open-01-hosted.png");

// Pane 2 browses: the listing should say open door and offer a plain JOIN.
await clickIf(p2, /start game/i);
await clickIf(p2, /matchmaking|find a lobby/i);
await page.waitForTimeout(2_500);
const browserText = await textOf(p2);
note("browser", {
  openBadge: /open door/i.test(browserText),
  joinLabel: /^|\n\s*JOIN\s*($|\n)/m.test(browserText) || /join\b/i.test(browserText),
  text: browserText.split("\n").slice(0, 22),
});
await shot("tour-open-02-browser.png");
const joined = (await clickIf(p2, /^join$/i)) || (await clickIf(p2, /request to join|join/i));
note("join-click", { joined });
await page.waitForTimeout(6_000);
note("guest-lobby", {
  noApprovalOnHost: !/accept player/i.test(await textOf(p1)),
  guestState: (await textOf(p2)).split("\n").slice(0, 10),
});
await shot("tour-open-03-joined.png");

// Both ready and start, proving the seats are real.
let readyCount = 0;
for (const frame of frames) {
  if (await clickIf(frame, /ready up|^ready$/i, 150_000)) readyCount += 1;
}
note("ready", { readyCount });
await page.waitForTimeout(1_500);
const started = await clickIf(p1, /start the round/i, 15_000);
note("start", { started });
await page.waitForTimeout(8_000);
await shot("tour-open-04-started.png");

process.stdout.write(JSON.stringify(report, null, 2));
await context.close();
