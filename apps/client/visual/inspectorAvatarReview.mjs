/* global process, window, document */

import { chromium } from "@playwright/test";
import path from "node:path";

const baseUrl = process.env.FOLDSEEK_VISUAL_URL ?? "http://127.0.0.1:4178";
const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning") {
    errors.push(`${message.type()}: ${message.text()}`);
  }
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.url()}`);
});

const frames = [
  ["hider-run", "view=hider&walk=0.86&aim=0.2&t=1.37&webgl"],
  ["profile-aim", "view=profile&walk=0.18&aim=1&pitch=-8&t=0.9&webgl"],
  ["shoulder-aim", "view=inspector&walk=0.45&aim=1&pitch=5&t=1.15&webgl"],
];
const reports = [];
for (const [name, query] of frames) {
  await page.goto(`${baseUrl}/body-viewer.html?${query}`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => window.bodyViewer?.ready || window.bodyViewer?.error, null, {
      timeout: 12_000,
    });
  } catch (error) {
    const stalled = await page.evaluate(() => ({
      bodyViewer: window.bodyViewer,
      hud: document.getElementById("hud")?.textContent ?? null,
    }));
    throw new Error(`${name} stalled: ${JSON.stringify({ stalled, errors })}`, { cause: error });
  }
  const report = await page.evaluate(() => window.bodyViewer);
  reports.push({ name, report });
  if (report?.error) throw new Error(`${name}: ${report.error}`);
  await page.screenshot({ path: path.join(outputDir, `inspector-avatar-${name}.png`) });
}

process.stdout.write(JSON.stringify({ reports, errors }, null, 2));
await browser.close();
