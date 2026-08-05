/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The Forge tool audit inside the live Portals editor (2026-08-05): an
 * open-door room with bots, then every tool exercised in pane one with
 * pane-fraction coordinates. The editor is the environment of record, so
 * this is the run that says "done".
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
const note = (step, detail) => report.steps.push({ step, ...detail });
const shot = (name) => page.screenshot({ path: path.join(outputDir, name) });

await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(30_000);

const frames = page.frames().filter((frame) => /arcade\.portals\.to\/drafts\/editor/.test(frame.url()));
if (frames.length === 0) throw new Error("no Portals player frame");
const game = frames[0];

const paneBox = async () => {
  const boxes = await page.locator("iframe").evaluateAll((nodes) =>
    nodes
      .filter((node) => /arcade\.portals\.to\/drafts\/editor/.test(node.src ?? ""))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      }),
  );
  const box = boxes[0];
  if (box === undefined) throw new Error("pane box unavailable");
  return box;
};
/** Page coordinates from pane fractions, 0..1 in each axis. */
const at = async (fx, fy) => {
  const box = await paneBox();
  return { x: box.x + box.w * fx, y: box.y + box.h * fy };
};
const clickAt = async (fx, fy, modifiers = {}) => {
  const point = await at(fx, fy);
  if (modifiers.shift) await page.keyboard.down("Shift");
  await page.mouse.click(point.x, point.y);
  if (modifiers.shift) await page.keyboard.up("Shift");
};
const dragAt = async (fx0, fy0, fx1, fy1) => {
  const from = await at(fx0, fy0);
  const to = await at(fx1, fy1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
};
const textOf = async () => (await game.locator("body").innerText().catch(() => "")).slice(0, 8_000);
const interesting = async () =>
  (await textOf())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /editing|selected|sampled|dropper|holding|panel|socket|cannot|locked|deployed|copied|swatch|painted|resize/i.test(line),
    )
    .slice(-3);
const clickIf = async (name, timeout = 5_000) => {
  const button = game.getByRole("button", { name }).first();
  try {
    await button.waitFor({ timeout });
    await button.click();
    return true;
  } catch {
    return false;
  }
};

await clickIf(/enter the shop/i, 45_000);
await page.waitForTimeout(2_000);
await clickIf(/start game/i);
await clickIf(/matchmaking|find a lobby/i);
await page.waitForTimeout(1_500);
await clickIf(/custom room and training/i);
await page.waitForTimeout(1_000);
await clickIf(/vetted door/i);
await clickIf(/new room/i);
await page.waitForTimeout(3_000);

// Fill with bots so a full round deals, then start.
const ready = game.getByRole("button", { name: /ready up|^ready$/i }).first();
await ready.waitFor({ timeout: 150_000 });
for (let i = 0; i < 3; i += 1) {
  await clickIf(/add a bot/i, 3_000);
  await page.waitForTimeout(300);
}
await ready.click();
await page.waitForTimeout(1_200);
await clickIf(/start the round/i, 15_000);

// Reach the forge as the mimic; a dealt Inspector rides the round to the
// rematch, where roles rotate away from whoever held the gun.
let phase = "other";
for (let cycle = 0; cycle < 2 && phase !== "forge"; cycle += 1) {
  for (let step = 0; step < 45; step += 1) {
    await page.waitForTimeout(4_000);
    const text = await textOf();
    if (/collapse forge tools/i.test(text)) {
      phase = "forge";
      break;
    }
    if (/stand by/i.test(text)) {
      phase = "vigil";
      break;
    }
  }
  if (phase !== "vigil") break;
  note("dealt-inspector", { cycle });
  for (let step = 0; step < 60; step += 1) {
    await page.waitForTimeout(4_000);
    if (/play another round/i.test(await textOf())) break;
  }
  await clickIf(/play another round/i, 8_000);
  phase = "other";
}
note("phase", { phase });
if (phase !== "forge") {
  process.stdout.write(JSON.stringify(report, null, 2));
  await context.close();
  process.exit(0);
}
const skip = game.getByRole("button", { name: /^skip$/i }).first();
if (await skip.isVisible().catch(() => false)) await skip.click();

// SHAPE: select, highlight, multi-select, resize, undo.
await clickAt(0.5, 0.5);
await page.keyboard.press("2");
await page.waitForTimeout(500);
await clickAt(0.5, 0.6);
await page.waitForTimeout(500);
note("shape-select", { status: await interesting() });
await clickAt(0.5, 0.42, { shift: true });
await page.waitForTimeout(500);
note("shape-multi", { status: await interesting() });
await shot("editor-audit-shape-before.png");
await dragAt(0.67, 0.47, 0.79, 0.48);
await page.waitForTimeout(700);
note("shape-drag", { status: await interesting() });
await shot("editor-audit-shape-after.png");

// PANELS: a click near the body deploys from a socket.
await page.keyboard.press("3");
await page.waitForTimeout(600);
let panelHit = null;
for (const [fx, fy] of [[0.5, 0.42], [0.5, 0.47], [0.5, 0.55], [0.5, 0.62], [0.48, 0.5], [0.52, 0.5], [0.5, 0.68]]) {
  await clickAt(fx, fy);
  await page.waitForTimeout(450);
  const status = (await interesting()).join(" | ");
  if (/deployed|panel on/i.test(status)) {
    panelHit = { fx, fy, status };
    break;
  }
}
note("panels", { panelHit });
await shot("editor-audit-panels.png");

// MATERIAL: arm the dropper, copy an own part, apply to another.
await page.keyboard.press("4");
await page.waitForTimeout(500);
await page.keyboard.press("f");
await page.waitForTimeout(400);
note("material-armed", { status: await interesting() });
await clickAt(0.5, 0.55);
await page.waitForTimeout(500);
note("material-sample", { status: await interesting() });
await clickAt(0.5, 0.45);
await page.waitForTimeout(500);
note("material-apply", { status: await interesting() });
await shot("editor-audit-material.png");

// PAINT: one stroke.
await page.keyboard.press("5");
await page.waitForTimeout(600);
await dragAt(0.49, 0.52, 0.53, 0.57);
await page.waitForTimeout(500);
note("paint", { paintUsed: /paint used/i.test(await textOf()) });

// POSE limb-grab, then lock and unlock.
await page.keyboard.press("1");
await page.waitForTimeout(400);
await dragAt(0.5, 0.56, 0.55, 0.5);
await page.waitForTimeout(500);
note("pose", { status: await interesting() });
await clickAt(0.5, 0.5);
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
note("lock", { locked: /disguise locked/i.test(await textOf()) });
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
note("unlock", { unlocked: !/disguise locked/i.test(await textOf()) });
await shot("editor-audit-final.png");

process.stdout.write(JSON.stringify(report, null, 2));
await context.close();
