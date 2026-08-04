/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Verifies the 2026-08-04 expansion build live in the Portals editor: enters
 * the shop, starts a solo round against bots, and screenshots the round as the
 * map builds and the Forge opens, collecting every console error on the way.
 * Headless by rule (docs/GAUNTLET_LOOP.md): feel verdicts belong to the user,
 * boot-and-build verdicts belong here.
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

await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(30_000);

const frames = page.frames().filter((frame) => /arcade\.portals\.to\/drafts\/editor/.test(frame.url()));
if (frames.length === 0) throw new Error("no Portals player frame found");
const frame = frames[0];

const shot = async (name) => {
  await page.screenshot({ path: path.join(outputDir, name), fullPage: false });
};
const buttonsOf = async () =>
  frame.locator("button:visible").evaluateAll((nodes) => nodes.map((node) => node.innerText.trim()));

await frame.getByRole("button", { name: /enter the shop/i }).click();
await page.waitForTimeout(2_000);
const menuButtons = await buttonsOf();

// Into matchmaking, then open a fresh room.
let entered = false;
const matchmaking = frame.getByRole("button", { name: /matchmaking|find a lobby/i }).first();
if (await matchmaking.isVisible().catch(() => false)) {
  await matchmaking.click();
  await page.waitForTimeout(2_500);
}
const afterEntry = await buttonsOf();
const custom = frame.getByRole("button", { name: /custom room and training/i }).first();
if (await custom.isVisible().catch(() => false)) {
  await custom.click();
  await page.waitForTimeout(2_500);
}
const creationButtons = await buttonsOf();
for (const label of [/forge practice/i, /new room/i, /open a room/i, /^open( room)?$/i, /create/i]) {
  const button = frame.getByRole("button", { name: label }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    entered = true;
    break;
  }
}
await page.waitForTimeout(4_000);
await shot("expansion-1-lobby.png");

// Lobby: fill with bots if offered, ready up, start.
const addBot = frame.getByRole("button", { name: /add a bot/i }).first();
for (let i = 0; i < 3; i += 1) {
  if (await addBot.isVisible().catch(() => false)) await addBot.click();
  await page.waitForTimeout(300);
}
const readyButton = frame.getByRole("button", { name: /ready up|^ready$/i }).first();
if (await readyButton.isVisible().catch(() => false)) await readyButton.click();
await page.waitForTimeout(1_000);
const startRound = frame.getByRole("button", { name: /start the round/i }).first();
if (await startRound.isVisible().catch(() => false)) await startRound.click();

// The map build and shader sweep can take a couple of minutes on an iGPU.
const bodyText = async () => (await frame.locator("body").innerText()).slice(0, 3_000);
let phaseSeen = [];
for (let step = 0; step < 40; step += 1) {
  await page.waitForTimeout(6_000);
  const text = await bodyText();
  const marker =
    /the forge|fold tools|lock it in|pose tool/i.test(text) ? "forge" :
    /memorize the shop|baseline/i.test(text) ? "baseline" :
    /building|shaders|the walls and the floor|the lights|loading/i.test(text) ? "loading" :
    /warrants remaining|the hunt is on/i.test(text) ? "hunt" : "other";
  if (phaseSeen[phaseSeen.length - 1] !== marker) phaseSeen.push(marker);
  if (step === 10) await shot("expansion-2-loading.png");
  if (marker === "forge" || marker === "hunt") break;
}
await shot("expansion-3-round.png");

process.stdout.write(
  JSON.stringify(
    {
      entered,
      menuButtons: menuButtons.slice(0, 12),
      afterEntry: afterEntry.slice(0, 12),
      creationButtons: creationButtons.slice(0, 14),
      phaseSeen,
      finalText: (await bodyText()).split("\n").slice(0, 24),
      errors: errors.slice(0, 40),
    },
    null,
    2,
  ),
);
await context.close();
