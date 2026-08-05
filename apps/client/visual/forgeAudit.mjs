/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

/**
 * The full Forge tool audit (2026-08-05): drives every tool in a solo round
 * and asserts what the status line, the panel, and the undo stack report.
 * Pose limb-grab, Shape single and multi resize, Panels socket placement,
 * Material sampling by key and by F-click, Paint stroke and undo, Mirror,
 * lock and unlock. Screenshots at every beat for the visual record.
 */

const bundleRoot = path.resolve(process.cwd(), "../..", "portals");
const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".mp3": "audio/mpeg" };
const server = http.createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let file = path.join(bundleRoot, decodeURIComponent(url.pathname));
    try {
      const stat = await fs.stat(file).catch(() => null);
      if (stat === null && path.extname(file) !== "") {
        response.writeHead(404);
        response.end();
        return;
      }
      if (stat === null || stat.isDirectory()) file = path.join(bundleRoot, "index.html");
      response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      response.end(await fs.readFile(file));
    } catch {
      response.writeHead(404);
      response.end();
    }
  })();
});
await new Promise((resolve) => server.listen(4187, "127.0.0.1", resolve));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const report = { steps: [], errors };
const note = (step, detail) => report.steps.push({ step, ...detail });
const shot = (name) => page.screenshot({ path: path.join(outputDir, name) });
const bodyText = async () => (await page.locator("body").innerText().catch(() => ""));
const statusLine = async () => {
  const text = await bodyText();
  const interesting = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /editing|selected|sampled|dropper|holding|panel|socket|cannot|locked|stowed|undid|copied|swatch|allowed|resize|nothing under/i.test(
        line,
      ),
    );
  return interesting.slice(-2);
};
const resetUndo = async () => {
  for (let i = 0; i < 12; i += 1) {
    if ((await undoEnabled()) !== true) break;
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(150);
  }
};
const undoEnabled = async () =>
  page
    .locator("button", { hasText: /^Undo/ })
    .first()
    .evaluate((node) => (node instanceof HTMLButtonElement ? !node.disabled : null))
    .catch(() => null);

await page.goto("http://127.0.0.1:4187/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /enter the shop/i }).click({ timeout: 45_000 });
await page.waitForTimeout(1_200);
for (const label of [/^start game/i, /begin solo round/i]) {
  const button = page.getByRole("button", { name: label }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await page.waitForTimeout(1_200);
  }
}
const ready = page.getByRole("button", { name: /ready up/i }).first();
await ready.waitFor({ timeout: 60_000 });
await ready.click();
await page.waitForTimeout(1_000);
const start = page.getByRole("button", { name: /start the round/i }).first();
for (let attempt = 0; attempt < 10; attempt += 1) {
  if (await start.isEnabled().catch(() => false)) {
    await start.click();
    break;
  }
  await page.waitForTimeout(1_000);
}
for (let step = 0; step < 40; step += 1) {
  await page.waitForTimeout(3_000);
  if (/collapse forge tools/i.test(await bodyText())) break;
}
const skip = page.getByRole("button", { name: /^skip$/i }).first();
if (await skip.isVisible().catch(() => false)) await skip.click();
await page.waitForTimeout(400);

const CENTRE = { x: 640, y: 360 };

// ---------------------------------------------------------------- 1 · POSE
await page.mouse.click(CENTRE.x, CENTRE.y);
await page.keyboard.press("1");
await page.waitForTimeout(500);
// Grab the body itself (limb-grab) and pull: undo must arm.
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(700, 340, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(600);
note("pose", { undoAfterLimbDrag: await undoEnabled(), status: await statusLine() });
await shot("audit-1-pose.png");

// ---------------------------------------------------------------- 2 · SHAPE
await resetUndo();
await page.keyboard.press("2");
await page.waitForTimeout(500);
await page.mouse.click(640, 430);
await page.waitForTimeout(500);
note("shape-select", { status: await statusLine() });
await page.keyboard.down("Shift");
await page.mouse.click(640, 300);
await page.keyboard.up("Shift");
await page.waitForTimeout(500);
note("shape-multi", { status: await statusLine() });
await shot("audit-2-shape-before.png");
// Pull the red (width) arrow from beside the gizmo centre outward.
await page.mouse.move(860, 340);
await page.mouse.down();
await page.mouse.move(1010, 350, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(700);
note("shape-drag", { undoAfterResize: await undoEnabled(), status: await statusLine() });
await shot("audit-2-shape-after.png");

// --------------------------------------------------------------- 3 · PANELS
await resetUndo();
await page.keyboard.press("3");
await page.waitForTimeout(600);
await shot("audit-3-panels-markers.png");
// Probe a grid of points over the body for a socket; note the first success.
let panelHit = null;
for (const [dx, dy] of [[0, -60], [0, -20], [0, 20], [0, 60], [-25, 0], [25, 0], [-25, -50], [25, -50], [0, 90]]) {
  await page.mouse.click(CENTRE.x + dx, CENTRE.y + dy);
  await page.waitForTimeout(450);
  const status = await statusLine();
  if (/panel/i.test(status)) {
    panelHit = { dx, dy, status };
    break;
  }
}
note("panels", { panelHit, status: await statusLine(), undo: await undoEnabled() });
await shot("audit-3-panels-after.png");

// ------------------------------------------------------------- 4 · MATERIAL
await resetUndo();
await page.keyboard.press("4");
await page.waitForTimeout(500);
// Hover affordance: resting the cursor on a part boxes it before any click.
await page.mouse.move(640, 380);
await page.waitForTimeout(500);
await shot("audit-4b-hover.png");
// F arms the dropper, exactly as paint's does.
await page.keyboard.press("f");
await page.waitForTimeout(400);
note("material-armed", { status: await statusLine() });
// The armed click copies whatever it lands on: the floor here.
await page.mouse.click(300, 620);
await page.waitForTimeout(500);
note("material-sample-click", { status: await statusLine() });
// Arm again and copy the creature's own part.
await page.keyboard.press("f");
await page.waitForTimeout(300);
await page.mouse.click(640, 400);
await page.waitForTimeout(500);
note("material-sample-own-part", { status: await statusLine() });
// Apply the held swatch to a body part with a plain click.
await page.mouse.click(640, 400);
await page.waitForTimeout(500);
note("material-apply", { status: await statusLine(), undo: await undoEnabled() });
await shot("audit-4-material.png");

// ---------------------------------------------------------------- 5 · PAINT
await page.keyboard.press("5");
await page.waitForTimeout(600);
await page.mouse.move(620, 380);
await page.mouse.down();
await page.mouse.move(670, 420, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500);
note("paint", { status: await statusLine(), text: /paint used/i.test(await bodyText()) });
await shot("audit-5-paint.png");

// ------------------------------------------------- mirror · undo · lock
await page.keyboard.press("m");
await page.waitForTimeout(300);
const mirrorOn = /mirror/i.test(await bodyText());
await page.keyboard.press("m");
await page.mouse.click(CENTRE.x, CENTRE.y);
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
const lockedText = await bodyText();
note("lock", {
  mirrorToggled: mirrorOn,
  locked: /disguise locked/i.test(lockedText),
  cannotLock: lockedText.match(/cannot lock[^\n]*/i)?.[0] ?? null,
});
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
note("unlock", { unlocked: !/disguise locked/i.test(await bodyText()) });
await shot("audit-6-lock.png");

process.stdout.write(JSON.stringify(report, null, 2));
await browser.close();
server.close();
