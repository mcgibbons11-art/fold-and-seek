/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

/** Solo round, Shape tool, click the body: the resize arrows should appear. */

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
await new Promise((resolve) => server.listen(4186, "127.0.0.1", resolve));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.goto("http://127.0.0.1:4186/", { waitUntil: "domcontentloaded" });
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
const bodyText = async () => (await page.locator("body").innerText().catch(() => ""));
for (let step = 0; step < 40; step += 1) {
  await page.waitForTimeout(3_000);
  if (/collapse forge tools/i.test(await bodyText())) break;
}

// Shape tool, then click the body's centre to select a part.
await page.mouse.click(640, 360);
await page.keyboard.press("2");
await page.waitForTimeout(600);
await page.mouse.click(640, 400);
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(outputDir, "gizmo-01-selected.png") });

// Shift-click a second part higher up the body.
await page.keyboard.down("Shift");
await page.mouse.click(640, 300);
await page.keyboard.up("Shift");
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(outputDir, "gizmo-02-multi.png") });

// Pull the red (width) arrow: from its shaft out to the right. The drag must
// land as one undoable command, which the Undo button's state reports.
const undoStateOf = async () =>
  page
    .locator("button", { hasText: /^Undo/ })
    .first()
    .evaluate((node) => (node instanceof HTMLButtonElement ? !node.disabled : null))
    .catch(() => null);
const undoBefore = await undoStateOf();
await page.mouse.move(860, 340);
await page.mouse.down();
await page.mouse.move(980, 345, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(outputDir, "gizmo-03-dragged.png") });
const undoAfter = await undoStateOf();

const text = await bodyText();
process.stdout.write(
  JSON.stringify(
    {
      shapeStatus: text.split("\n").filter((line) => /parts selected|drag the arrows|editing/i.test(line)).slice(0, 4),
      panelShowsArrowsCopy: /red, green, and blue arrows/i.test(text),
      undoBefore,
      undoAfter,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
server.close();
