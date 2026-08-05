/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

/** Screenshots the menu and settings at a half-pane width (QA 2026-08-05). */

const bundleRoot = path.resolve(process.cwd(), "../..", "portals");
const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".mp3": "audio/mpeg", ".json": "application/json" };
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
await new Promise((resolve) => server.listen(4184, "127.0.0.1", resolve));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
await page.goto("http://127.0.0.1:4184/", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /enter the shop/i }).click({ timeout: 45_000 });
await page.waitForTimeout(2_500);
await page.screenshot({ path: path.join(outputDir, "narrow-menu-command.png") });
const settings = page.getByRole("button", { name: /settings/i }).first();
if (await settings.isVisible().catch(() => false)) {
  await settings.click();
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: path.join(outputDir, "narrow-menu-settings.png") });
}
process.stdout.write("done\n");
await browser.close();
server.close();
