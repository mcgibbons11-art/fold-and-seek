/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

/** Focused check: armed dropper click on undeclared surfaces resolves. */

const bundleRoot = path.resolve(process.cwd(), "../..", "portals");
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
await new Promise((resolve) => server.listen(4189, "127.0.0.1", resolve));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto("http://127.0.0.1:4189/", { waitUntil: "domcontentloaded" });
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
let inForge = false;
for (let step = 0; step < 40; step += 1) {
  await page.waitForTimeout(3_000);
  if (/collapse forge tools/i.test(await bodyText())) {
    inForge = true;
    break;
  }
}
if (!inForge) {
  process.stdout.write(
    JSON.stringify({ failedToReachForge: (await bodyText()).split("\n").slice(0, 12) }, null, 2),
  );
  await browser.close();
  server.close();
  process.exit(2);
}
const skip = page.getByRole("button", { name: /^skip$/i }).first();
if (await skip.isVisible().catch(() => false)) await skip.click();

await page.mouse.click(640, 360);
await page.keyboard.press("4");
await page.waitForTimeout(500);

const statusOf = async () => {
  const text = await bodyText();
  return (
    text
      .split("\n")
      .find((line) =>
        /dropper|sampled|matched|worn as|publishes no|not allowed|nothing under|holding/i.test(line),
      ) ?? "(none)"
  );
};
const sampleAt = async (x, y) => {
  await page.keyboard.press("f");
  await page.waitForTimeout(250);
  const armed = await statusOf();
  await page.mouse.click(x, y);
  await page.waitForTimeout(500);
  const after = await statusOf();
  return { armed, after };
};

const results = {
  floor: await sampleAt(300, 640),
  wallOrShelfLeft: await sampleAt(120, 240),
  furnitureRight: await sampleAt(1120, 300),
  highShelf: await sampleAt(980, 140),
};
process.stdout.write(JSON.stringify(results, null, 2));
await browser.close();
server.close();
