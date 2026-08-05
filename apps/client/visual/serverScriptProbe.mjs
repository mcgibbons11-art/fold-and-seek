/* global process */

import { chromium } from "@playwright/test";

/**
 * Reads the live session's shared state looking for the `server:` keys the
 * probe scripts write (2026-08-06). A `server:`-prefixed key can only be
 * written by a server script, so its presence proves the script ran - and
 * which key appears names the location Portals took it from.
 */

const profile = process.env.FOLDSEEK_AUTH_PROFILE;
if (!profile) throw new Error("FOLDSEEK_AUTH_PROFILE is required");

const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1400, height: 900 },
  args: ["--profile-directory=Default"],
});
const page = context.pages()[0] ?? (await context.newPage());
const consoleLines = [];
page.on("console", (message) => {
  const text = message.text();
  if (/foldseek probe|server/i.test(text)) consoleLines.push(`${message.type()}: ${text}`);
});

await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(30_000);

const frames = page.frames().filter((f) => /arcade\.portals\.to\/drafts\/editor/.test(f.url()));
if (frames.length === 0) throw new Error("no Portals player frame");
const frame = frames[0];

// Enter the shop so the game joins the relay session, which is what starts a
// server script for that session.
const enter = frame.getByRole("button", { name: /enter the shop/i }).first();
if (await enter.isVisible().catch(() => false)) await enter.click();
await page.waitForTimeout(6_000);

const read = async () =>
  frame.evaluate(async () => {
    const portals = window.Portals;
    if (portals === undefined || portals.net === undefined) return { sdk: false };
    let state = null;
    try {
      state = portals.net.getState();
    } catch (error) {
      return { sdk: true, error: String(error) };
    }
    const keys = state === null || state === undefined ? [] : Object.keys(state);
    const serverKeys = keys.filter((key) => key.startsWith("server:"));
    const values = {};
    for (const key of serverKeys) values[key] = state[key];
    return {
      sdk: true,
      version: portals.version ?? null,
      totalKeys: keys.length,
      serverKeys,
      values,
      // Does the SDK itself advertise anything server-shaped to a client?
      netMembers: Object.keys(portals.net).sort(),
      portalsMembers: Object.keys(portals).sort(),
    };
  });

let result = await read();
// The probe writes on boot and on join; give the session a few beats.
for (let attempt = 0; attempt < 10 && (result.serverKeys ?? []).length === 0; attempt += 1) {
  await page.waitForTimeout(3_000);
  result = await read();
}

// Ask the probe to answer, which also proves the message path both ways.
const ack = await frame.evaluate(async () => {
  const portals = window.Portals;
  if (portals?.net === undefined) return "no sdk";
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("no ack in 5s"), 5_000);
    try {
      portals.net.on("message", (data) => {
        if (data && data.t === "foldseek_probe_ack") {
          clearTimeout(timer);
          resolve(`ack from ${String(data.where)}`);
        }
      });
      portals.net.send({ t: "foldseek_probe" });
    } catch (error) {
      clearTimeout(timer);
      resolve(`send failed: ${String(error)}`);
    }
  });
});

process.stdout.write(
  JSON.stringify({ ...result, ack, consoleLines: consoleLines.slice(0, 20) }, null, 2),
);
await context.close();
