/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

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
const messages = [];
page.on("console", (message) => {
  const text = message.text();
  if (message.type() === "error" || message.type() === "warning") {
    messages.push(`${message.type()}: ${text}`);
  }
});
page.on("pageerror", (error) => messages.push(`page: ${error.message}`));
page.on("requestfailed", (request) => {
  messages.push(`requestfailed: ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`);
});

await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(30_000);
const onePlayer = page.getByRole("button", { name: /^1p$/i });
if (await onePlayer.isVisible().catch(() => false)) {
  await onePlayer.click();
  await page.waitForTimeout(5_000);
}
const frames = page.frames().filter((frame) => /arcade\.portals\.to\/drafts\/editor/.test(frame.url()));
if (frames.length === 0) throw new Error("No Portals game pane found");

const results = [];
for (const [index, frame] of frames.entries()) {
  await frame.getByRole("button", { name: /enter the shop/i }).click();
  const solo = frame.getByRole("button", { name: /begin solo round/i });
  const matchmaking = frame.getByRole("button", { name: /^matchmaking$/i });
  await Promise.race([
    solo.waitFor({ timeout: 45_000 }),
    matchmaking.waitFor({ timeout: 45_000 }),
  ]);
  if (await matchmaking.isVisible().catch(() => false)) {
    await matchmaking.click();
    await frame.getByRole("button", { name: /return to main menu/i }).waitFor({ timeout: 15_000 });
    const body = await frame.locator("body").innerText();
    const reconnectVisible = await frame
      .getByRole("button", { name: /^reconnect$/i })
      .isVisible()
      .catch(() => false);
    if (/could not connect|unavailable/i.test(body) && !reconnectVisible) {
      throw new Error(`Matchmaking reported an outage without a reconnect action:\n${body.slice(0, 4_000)}`);
    }
    results.push({
      player: index + 1,
      mode: reconnectVisible ? "matchmaking waiting for reconnect" : "matchmaking connected",
      reconnectVisible,
    });
    continue;
  }

  await solo.click();
  const deadline = Date.now() + 180_000;
  let body = "";
  while (Date.now() < deadline) {
    await frame.waitForTimeout(2_000);
    body = await frame.locator("body").innerText();
    if (/READY UP|ROUND 1|FOLD\n|STAND BY/.test(body)) break;
  }
  if (!/READY UP|ROUND 1|FOLD\n|STAND BY/.test(body)) {
    throw new Error(`Solo fallback never opened the shop. Last pane text:\n${body.slice(0, 4_000)}\nMessages:\n${messages.join("\n")}`);
  }
  results.push({
    player: index + 1,
    mode: "solo fallback",
    body: body.slice(0, 2_000),
  });
}

const fatal = messages.filter((entry) => /\[round\] could not open the shop|page:|console error/i.test(entry));
await page.screenshot({ path: path.join(outputDir, "portals-relay-fallback.png"), fullPage: false });
if (fatal.length > 0) throw new Error(`Fatal fallback errors: ${fatal.join("\n")}`);
process.stdout.write(JSON.stringify({ results, messages, fatal }, null, 2));
await context.close();
