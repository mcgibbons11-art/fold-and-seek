/* global process */

import { chromium } from "@playwright/test";

/**
 * Enumerates the Portals SDK actually injected into our live build. Docs lag
 * and the editor injects its own `./_portals/sdk.js`, so the ground truth for
 * "what can this game call" is the object at runtime (2026-08-06).
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
await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(30_000);

const frame = page.frames().find((f) => /arcade\.portals\.to\/drafts\/editor/.test(f.url()));
if (frame === undefined) throw new Error("no Portals player frame");

const surface = await frame.evaluate(() => {
  const describe = (value, depth) => {
    if (value === null || value === undefined) return String(value);
    const type = typeof value;
    if (type === "function") return `fn(${String(value.length)})`;
    if (type !== "object") return type;
    if (depth <= 0) return "object";
    const out = {};
    for (const key of Object.keys(value).sort()) {
      let entry;
      try {
        entry = value[key];
      } catch {
        entry = "<throws>";
      }
      out[key] = describe(entry, depth - 1);
    }
    return out;
  };
  const portals = window.Portals;
  if (portals === undefined) return { present: false };
  return {
    present: true,
    version: portals.version ?? null,
    surface: describe(portals, 3),
  };
});

process.stdout.write(JSON.stringify(surface, null, 2));
await context.close();
