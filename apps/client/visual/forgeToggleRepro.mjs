/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

/**
 * Reproduces the live-play report "the Expand Forge tools button sometimes
 * greys out and stops responding". Serves the built bundle without a Portals
 * SDK so the game runs its offline path, plays into a round as the Mimic, and
 * probes the collapse/expand toggle through every state the session can put
 * around it: fresh forge, locked disguise, paint mode, and the hunt dock with
 * and without the missed-finds board open. Each probe records the button's
 * bounding box, computed style, and the actual element stack under its centre,
 * then clicks and checks the panels responded.
 */

const bundleRoot = path.resolve(process.cwd(), "../..", "portals");
const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
await fs.mkdir(outputDir, { recursive: true });

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
};

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
      const body = await fs.readFile(file);
      response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  })();
});
await new Promise((resolve) => server.listen(4181, "127.0.0.1", resolve));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

const report = { probes: [], phaseSeen: [], errors };
const shot = (name) => page.screenshot({ path: path.join(outputDir, name) });

/** Full diagnosis of whichever toggle (expand or collapse) is on screen. */
async function probeToggle(label) {
  const result = await page.evaluate(() => {
    const button = document.querySelector(
      '[title="Expand Forge tools"], [title="Collapse Forge tools"]',
    );
    if (button === null) return { found: false };
    const box = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const stack = document
      .elementsFromPoint(cx, cy)
      .slice(0, 5)
      .map((node) => {
        const nodeStyle = getComputedStyle(node);
        return {
          tag: node.tagName.toLowerCase(),
          label: node.getAttribute("aria-label") ?? node.getAttribute("data-hud-region") ?? node.className?.toString?.().slice(0, 40) ?? "",
          pointerEvents: nodeStyle.pointerEvents,
          opacity: nodeStyle.opacity,
          background: nodeStyle.backgroundColor,
        };
      });
    return {
      found: true,
      title: button.getAttribute("title"),
      disabled: button.disabled,
      box: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
      onScreen: box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      filter: style.filter,
      centreHitsButton: document.elementsFromPoint(cx, cy)[0] === button || button.contains(document.elementsFromPoint(cx, cy)[0]),
      stack,
    };
  });
  report.probes.push({ label, ...result });
  return result;
}

/** Clicks the toggle by coordinates (the way a player does) and reports whether it flipped. */
async function clickToggle(label) {
  const before = await probeToggle(`${label}:before`);
  if (!before.found) return false;
  await page.mouse.click(before.box.x + before.box.w / 2, before.box.y + before.box.h / 2);
  await page.waitForTimeout(400);
  const after = await probeToggle(`${label}:after`);
  const flipped = after.found && after.title !== before.title;
  report.probes.push({ label: `${label}:flipped`, flipped });
  return flipped;
}

await page.goto("http://127.0.0.1:4181/", { waitUntil: "domcontentloaded" });
const bodyText = async () => (await page.locator("body").innerText().catch(() => "")).slice(0, 3000);

// Menu ladder: whatever start affordances this build shows, walk into a round.
await page.getByRole("button", { name: /enter the shop/i }).click({ timeout: 45_000 });
await page.waitForTimeout(1_500);
report.menuButtons = await page
  .locator("button:visible")
  .evaluateAll((nodes) => nodes.map((node) => node.innerText.trim()).slice(0, 16));
// Offline path: START GAME opens the solo pane, BEGIN SOLO ROUND deals it.
for (const label of [/^start game/i, /begin solo round/i]) {
  const button = page.getByRole("button", { name: label }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await page.waitForTimeout(1_200);
  }
}
const ready = page.getByRole("button", { name: /ready up|^ready$/i }).first();
await ready.waitFor({ timeout: 30_000 }).catch(() => {});
if (await ready.isVisible().catch(() => false)) await ready.click();
await page.waitForTimeout(1_200);
const start = page.getByRole("button", { name: /start the round/i }).first();
for (let attempt = 0; attempt < 10; attempt += 1) {
  if (await start.isEnabled().catch(() => false)) {
    await start.click();
    break;
  }
  await page.waitForTimeout(1_000);
}

// Wait for the forge (mimic) or the hunt (inspector) to arrive. The markers
// must be HUD-only strings: menu copy also contains the word "hunt".
let phase = "other";
for (let step = 0; step < 50; step += 1) {
  await page.waitForTimeout(4_000);
  const text = await bodyText();
  phase =
    /collapse forge tools|lock disguise|forge ·/i.test(text) ? "forge" :
    /warrants remaining|warrants left/i.test(text) ? "hunt" :
    /building|shaders|loading|memorize/i.test(text) ? "loading" : "other";
  if (report.phaseSeen[report.phaseSeen.length - 1] !== phase) report.phaseSeen.push(phase);
  if (phase === "forge" || phase === "hunt") break;
}
await shot("toggle-1-round-entry.png");
report.role = phase === "forge" ? "mimic" : "unknown";

if (phase === "forge") {
  // Forge phase: cycle the toggle, then again with the disguise locked, then in paint.
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await clickToggle(`forge-collapse-${cycle}`);
    await clickToggle(`forge-expand-${cycle}`);
  }
  await page.keyboard.press("Enter"); // lock
  await page.waitForTimeout(600);
  await clickToggle("forge-locked-collapse");
  await clickToggle("forge-locked-expand");
  await page.keyboard.press("Escape"); // unlock
  await page.waitForTimeout(400);
  await page.keyboard.press("5"); // paint mode
  await page.waitForTimeout(600);
  await clickToggle("forge-paint-collapse");
  await clickToggle("forge-paint-expand");
  await shot("toggle-2-forge-probes.png");

  // Ride into the hunt. A hider's hunt HUD says "Being watched", never
  // "warrants remaining" - that is the Inspector's line.
  for (let step = 0; step < 60; step += 1) {
    await page.waitForTimeout(4_000);
    if (/being watched|missed spots/i.test(await bodyText())) {
      phase = "hunt";
      break;
    }
  }
}

if (phase === "hunt") {
  await page.waitForTimeout(3_000);
  await shot("toggle-3-hunt-entry.png");
  // Plain collapse/expand in the dock.
  await clickToggle("hunt-collapse");
  await shot("toggle-4-hunt-collapsed.png");
  await clickToggle("hunt-expand");
  // The suspected wedge: open the board, then collapse.
  const board = page.getByRole("button", { name: /missed|board/i }).first();
  if (await board.isVisible().catch(() => false)) {
    await board.click();
    await page.waitForTimeout(600);
    await shot("toggle-5-board-open.png");
    await clickToggle("hunt-board-collapse");
    await shot("toggle-6-board-collapsed.png");
    await clickToggle("hunt-board-expand");
  } else {
    report.probes.push({ label: "board-button", found: false });
  }
}

report.finalText = (await bodyText()).split("\n").slice(0, 20);
process.stdout.write(JSON.stringify(report, null, 2));
await browser.close();
server.close();
