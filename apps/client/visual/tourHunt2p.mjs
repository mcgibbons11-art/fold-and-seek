/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Hunt-phase coverage in the Portals editor's two-player view, picking up the
 * beats tourRound2p.mjs missed: the disguise lock, the taunt and its own-ear
 * feedback, the missed-finds board, an inspector warrant shot with its caption
 * and counter, and the rematch vote counter on the results screen.
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
const shot = (name) => page.screenshot({ path: path.join(outputDir, name) });
const note = (step, detail) => report.steps.push({ step, ...detail });

async function textOf(frame) {
  return (await frame.locator("body").innerText().catch(() => "")).slice(0, 8_000);
}

async function clickIf(frame, name, timeout = 4_000) {
  const button = frame.getByRole("button", { name }).first();
  try {
    await button.waitFor({ timeout });
    await button.click();
    return true;
  } catch {
    return false;
  }
}

async function paneCentre(paneIndex) {
  const boxes = await page.locator("iframe").evaluateAll((nodes) =>
    nodes
      .filter((node) => /arcade\.portals\.to\/drafts\/editor/.test(node.src ?? ""))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }),
  );
  return boxes[paneIndex] ?? null;
}

async function drive(paneIndex, keys, holdMs) {
  const centre = await paneCentre(paneIndex);
  if (centre === null) return;
  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(150);
  for (const key of keys) await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  for (const key of keys) await page.keyboard.up(key);
}

await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(30_000);

const frames = page.frames().filter((frame) => /arcade\.portals\.to\/drafts\/editor/.test(frame.url()));
if (frames.length < 2) throw new Error(`need two panes, found ${frames.length}`);
const [p1, p2] = frames;

for (const frame of frames) await clickIf(frame, /enter the shop/i, 45_000);
await page.waitForTimeout(2_000);

await clickIf(p1, /start game/i);
await clickIf(p1, /matchmaking|find a lobby/i);
await page.waitForTimeout(1_500);
await clickIf(p1, /custom room and training/i);
await page.waitForTimeout(1_000);
await clickIf(p1, /new room/i);
await page.waitForTimeout(3_000);

await clickIf(p2, /start game/i);
await clickIf(p2, /matchmaking|find a lobby/i);
await page.waitForTimeout(2_500);
await clickIf(p2, /request to join/i);
await clickIf(p1, /accept player/i, 15_000);

let readyCount = 0;
for (const frame of frames) {
  if (await clickIf(frame, /ready up|^ready$/i, 150_000)) readyCount += 1;
}
note("ready", { readyCount });
await page.waitForTimeout(1_500);
const started = await clickIf(p1, /start the round/i, 15_000);
note("start", { started });

let mimic = null;
let inspector = null;
for (let step = 0; step < 30; step += 1) {
  await page.waitForTimeout(4_000);
  if (/collapse forge tools|forge ·/i.test(await textOf(p1))) {
    mimic = { frame: p1, index: 0 };
    inspector = { frame: p2, index: 1 };
    break;
  }
  if (/collapse forge tools|forge ·/i.test(await textOf(p2))) {
    mimic = { frame: p2, index: 1 };
    inspector = { frame: p1, index: 0 };
    break;
  }
}
note("roles", { dealt: mimic !== null, mimicPane: mimic === null ? null : mimic.index + 1 });

if (mimic !== null && inspector !== null) {
  const m = mimic.frame;

  // Move somewhere hidden-ish, then lock, and prove the lock took.
  await drive(mimic.index, ["w"], 1_200);
  const mc = await paneCentre(mimic.index);
  if (mc !== null) await page.mouse.click(mc.x, mc.y);
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  note("lock", {
    locked: /disguise locked/i.test(await textOf(m)),
    header: (await textOf(m)).split("\n").slice(0, 6),
  });
  await shot("tour-hunt-01-locked.png");

  // Ride to the hunt on the real HUD strings.
  let huntSeen = false;
  for (let step = 0; step < 45; step += 1) {
    await page.waitForTimeout(4_000);
    const inspectorText = await textOf(inspector.frame);
    const mimicText = await textOf(m);
    if (/of \d+ ready|empty/i.test(inspectorText) || /being watched/i.test(mimicText)) {
      huntSeen = true;
      break;
    }
  }
  note("hunt", { huntSeen });
  await shot("tour-hunt-02-start.png");

  if (huntSeen) {
    // Mimic beats: the taunt button, its own-ear caption, and the board.
    const tauntClicked = await clickIf(m, /taunt/i);
    await page.waitForTimeout(900);
    const mimicText = await textOf(m);
    note("taunt", {
      tauntClicked,
      ownCaption: /you taunt/i.test(mimicText),
      cooldownShown: /\d+s/.test(mimicText),
    });
    const boardOpened = await clickIf(m, /missed|board/i);
    await page.waitForTimeout(800);
    await shot("tour-hunt-03-board.png");
    note("board", {
      boardOpened,
      text: (await textOf(m)).split("\n").slice(0, 24),
    });
    await clickIf(m, /missed|board/i);

    // Inspector beats: leave the office, sweep, and spend one warrant.
    const before = await textOf(inspector.frame);
    note("warrants-before", { chip: before.match(/(\d+)\s*\n?\s*OF (\d+) READY/i)?.slice(1) ?? null });
    await drive(inspector.index, ["w"], 3_000);
    const ic = await paneCentre(inspector.index);
    if (ic !== null) {
      await page.mouse.move(ic.x, ic.y + 60, { steps: 6 });
      await page.waitForTimeout(500);
      await page.mouse.click(ic.x, ic.y + 60);
    }
    await page.waitForTimeout(1_500);
    const after = await textOf(inspector.frame);
    note("shot", {
      fired: /warrant fired/i.test(after),
      chip: after.match(/(\d+)\s*\n?\s*OF (\d+) READY/i)?.slice(1) ?? null,
      captions: after
        .split("\n")
        .filter((line) => /fired|wrong|caught|reaction/i.test(line))
        .slice(0, 6),
    });
    await shot("tour-hunt-04-shot.png");
  }

  // Results: both vote for a rematch and the counter should say 2 of 2.
  let resultsSeen = false;
  for (let step = 0; step < 40; step += 1) {
    await page.waitForTimeout(4_000);
    if (/play another round/i.test(await textOf(p1))) {
      resultsSeen = true;
      break;
    }
  }
  note("results", { resultsSeen });
  if (resultsSeen) {
    const v1 = await clickIf(p1, /play another round/i, 6_000);
    const v2 = await clickIf(p2, /play another round/i, 6_000);
    await page.waitForTimeout(2_500);
    const tally = (await textOf(p1)).match(/(\d+)\s*\/\s*2 want another/i)?.[1] ?? null;
    note("rematch-votes", { v1, v2, tally });
    await shot("tour-hunt-05-votes.png");

    // If the vote carries, round two should deal with no first-round guide.
    await page.waitForTimeout(15_000);
    note("round2", {
      text: (await textOf(p1)).split("\n").slice(0, 10),
      guide: /first round/i.test(await textOf(p1)) || /first round/i.test(await textOf(p2)),
    });
    await shot("tour-hunt-06-round2.png");
  }
}

process.stdout.write(JSON.stringify(report, null, 2));
await context.close();
