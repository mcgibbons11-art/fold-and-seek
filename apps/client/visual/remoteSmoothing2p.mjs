/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Measures remote-Inspector smoothing in the live editor's two panes
 * (2026-08-06). The mimic's pane draws the other seat's Inspector from 10 Hz
 * telemetry; the diagnostics overlay counts how each presented frame was
 * produced. With the playhead trailing more than one sample interval the
 * steady state must be pure interpolation: samples keep arriving while
 * `extrap` and `held` stay flat. Those two climbing with the frame rate is
 * the stutter the player reported.
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

const frames = page.frames().filter((f) => /arcade\.portals\.to\/drafts\/editor/.test(f.url()));
if (frames.length < 2) throw new Error(`need two panes, found ${frames.length}`);
const [p1, p2] = frames;

const textOf = async (frame) => (await frame.locator("body").innerText().catch(() => "")).slice(0, 9_000);
const clickIf = async (frame, name, timeout = 5_000) => {
  const button = frame.getByRole("button", { name }).first();
  try {
    await button.waitFor({ timeout });
    await button.click();
    return true;
  } catch {
    return false;
  }
};
const paneBox = async (index) => {
  const boxes = await page.locator("iframe").evaluateAll((nodes) =>
    nodes
      .filter((node) => /arcade\.portals\.to\/drafts\/editor/.test(node.src ?? ""))
      .map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }),
  );
  const box = boxes[index];
  if (box === undefined) throw new Error("pane box unavailable");
  return box;
};
const focusPane = async (index) => {
  const box = await paneBox(index);
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  await page.waitForTimeout(150);
};

// Host an open-door room with bots so a full round deals.
await clickIf(p1, /enter the shop/i, 45_000);
await clickIf(p2, /enter the shop/i, 45_000);
await page.waitForTimeout(2_000);
await clickIf(p1, /start game/i);
await clickIf(p1, /matchmaking|find a lobby/i);
await page.waitForTimeout(1_500);
await clickIf(p1, /custom room and training/i);
await page.waitForTimeout(1_000);
await clickIf(p1, /vetted door/i);
await clickIf(p1, /new room/i);
await page.waitForTimeout(3_000);
await clickIf(p2, /start game/i);
await clickIf(p2, /matchmaking|find a lobby/i);
await page.waitForTimeout(2_500);
await clickIf(p2, /^join$/i);
await page.waitForTimeout(4_000);

const ready1 = p1.getByRole("button", { name: /ready up|^ready$/i }).first();
await ready1.waitFor({ timeout: 150_000 });
for (let i = 0; i < 2; i += 1) {
  await clickIf(p1, /add a bot/i, 3_000);
  await page.waitForTimeout(300);
}
await ready1.click();
await clickIf(p2, /ready up|^ready$/i, 20_000);
await page.waitForTimeout(1_200);
await clickIf(p1, /start the round/i, 20_000);

// Find the mimic pane: it is the one holding the Forge dock.
let mimic = null;
let inspector = null;
for (let step = 0; step < 45; step += 1) {
  await page.waitForTimeout(4_000);
  const t1 = await textOf(p1);
  const t2 = await textOf(p2);
  if (/collapse forge tools/i.test(t1)) {
    mimic = { frame: p1, index: 0 };
    inspector = { frame: p2, index: 1 };
    break;
  }
  if (/collapse forge tools/i.test(t2)) {
    mimic = { frame: p2, index: 1 };
    inspector = { frame: p1, index: 0 };
    break;
  }
}
note("roles", { mimicPane: mimic === null ? null : mimic.index + 1 });
if (mimic === null || inspector === null) {
  process.stdout.write(JSON.stringify(report, null, 2));
  await context.close();
  process.exit(2);
}

// Lock in so the Forge can end, then ride to the hunt - the remote Inspector
// body only exists once the office door opens.
await focusPane(mimic.index);
await page.keyboard.press("Enter");
let huntSeen = false;
for (let step = 0; step < 50; step += 1) {
  await page.waitForTimeout(4_000);
  if (/being watched|search time/i.test(await textOf(mimic.frame))) {
    huntSeen = true;
    break;
  }
}
note("hunt", { huntSeen });
if (!huntSeen) {
  process.stdout.write(JSON.stringify(report, null, 2));
  await context.close();
  process.exit(2);
}

// Diagnostics overlay on the mimic's pane: it is the seat presenting a
// remote body. Backtick toggles it.
await focusPane(mimic.index);
await page.keyboard.press("Backquote");
await page.waitForTimeout(1_200);

const counters = async () => {
  const text = await textOf(mimic.frame);
  const sample = text.match(/net sample\s+(\d+) ok · (\d+) reorder · (\d+) duplicate · (\d+) stale/);
  const smooth = text.match(/net smooth\s+(\d+) extrap · (\d+) held/);
  const frameLine = text.match(/frames\s+(\d+)/);
  return {
    ok: sample === null ? null : Number(sample[1]),
    reorder: sample === null ? null : Number(sample[2]),
    stale: sample === null ? null : Number(sample[4]),
    extrap: smooth === null ? null : Number(smooth[1]),
    held: smooth === null ? null : Number(smooth[2]),
    frames: frameLine === null ? null : Number(frameLine[1]),
  };
};

const before = await counters();
note("overlay", { visible: before.extrap !== null, before });
await shot("smoothing-1-overlay.png");
if (before.extrap === null) {
  process.stdout.write(JSON.stringify(report, null, 2));
  await context.close();
  process.exit(2);
}

// Drive the Inspector for a good stretch so real telemetry flows, then read
// the counters again from the watching seat.
for (let burst = 0; burst < 4; burst += 1) {
  await focusPane(inspector.index);
  for (const key of ["KeyW", "KeyA", "KeyD"]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(1_200);
    await page.keyboard.up(key);
  }
  const box = await paneBox(inspector.index);
  await page.mouse.move(box.x + box.w / 2 + 120, box.y + box.h / 2, { steps: 6 });
  await page.waitForTimeout(400);
}
await page.waitForTimeout(1_500);

const after = await counters();
const delta = {
  ok: (after.ok ?? 0) - (before.ok ?? 0),
  extrap: (after.extrap ?? 0) - (before.extrap ?? 0),
  held: (after.held ?? 0) - (before.held ?? 0),
  frames: (after.frames ?? 0) - (before.frames ?? 0),
};
// The verdict: samples must have flowed, and the frames presented over that
// window must not have been dominated by extrapolation or stale holds.
const degraded = delta.extrap + delta.held;
note("measurement", {
  before,
  after,
  delta,
  degradedFramesOverWindow: degraded,
  samplesFlowed: delta.ok > 0,
  verdict:
    delta.ok > 0 && degraded <= Math.max(4, delta.ok)
      ? "interpolated steady state"
      : "still extrapolating/stalling",
});
await shot("smoothing-2-after.png");

process.stdout.write(JSON.stringify(report, null, 2));
await context.close();
