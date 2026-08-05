/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Full two-player round in the Portals editor (2026-08-05 QA): pane 1 opens a
 * room, pane 2 joins it from the browser, both ready up, and the round runs
 * start to finish. During the Forge the mimic pane exercises every tool mode,
 * mirror, a starter preset, undo/redo, the collapse/expand toggle, paint, and
 * the lock, while the inspector pane wanders the redecorated Security Office.
 * During the hunt the mimic taunts and toggles the board; the inspector moves,
 * aims, and burns one warrant. The script then rides reveal and results to the
 * rematch screen, checking the first-round guide stays away for round two.
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
  return (await frame.locator("body").innerText().catch(() => "")).slice(0, 6_000);
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

/** Absolute page-space centre of a pane's canvas, for mouse work. */
async function paneCanvasCentre(paneIndex) {
  const boxes = await page.locator("iframe").evaluateAll((nodes) =>
    nodes
      .filter((node) => /arcade\.portals\.to\/drafts\/editor/.test(node.src ?? ""))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      }),
  );
  const box = boxes[paneIndex];
  if (box === undefined) return null;
  return { x: box.x + box.w / 2, y: box.y + box.h / 2, box };
}

/** Focus a pane by clicking dead centre, then hold keys for a moment. */
async function drive(paneIndex, keys, holdMs) {
  const centre = await paneCanvasCentre(paneIndex);
  if (centre === null) return;
  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(150);
  for (const key of keys) await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  for (const key of keys) await page.keyboard.up(key);
}

async function dragOnPane(paneIndex, fromDx, fromDy, toDx, toDy) {
  const centre = await paneCanvasCentre(paneIndex);
  if (centre === null) return;
  await page.mouse.move(centre.x + fromDx, centre.y + fromDy);
  await page.mouse.down();
  await page.mouse.move(centre.x + toDx, centre.y + toDy, { steps: 12 });
  await page.mouse.up();
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

// P1 opens a room; P2 joins it from the matchmaking browser.
await clickIf(p1, /start game/i);
await clickIf(p1, /matchmaking|find a lobby/i);
await page.waitForTimeout(1_500);
await clickIf(p1, /custom room and training/i);
await page.waitForTimeout(1_000);
const opened =
  (await clickIf(p1, /open a room/i)) ||
  (await clickIf(p1, /new room/i)) ||
  (await clickIf(p1, /^open( room)?$/i));
note("p1-open-room", { opened });
await page.waitForTimeout(3_000);

await clickIf(p2, /start game/i);
await clickIf(p2, /matchmaking|find a lobby/i);
await page.waitForTimeout(2_500);
await shot("tour-round-01-browser.png");
note("p2-browser", { text: (await textOf(p2)).split("\n").slice(0, 24) });
const joined = (await clickIf(p2, /request to join|join/i)) || (await clickIf(p2, /room/i));
note("p2-join", { joined });
await page.waitForTimeout(2_000);

// The host approves the join request, which seats both players in the lobby.
const accepted = await clickIf(p1, /accept player/i, 15_000);
note("p1-accept", { accepted });
await page.waitForTimeout(4_000);
await shot("tour-round-02-lobby.png");
note("lobby", {
  p1: (await textOf(p1)).split("\n").slice(0, 20),
  p2: (await textOf(p2)).split("\n").slice(0, 20),
});

// The shop compiles before the lobby appears; wait the load out, then ready
// both and let the host start.
let readyCount = 0;
for (const frame of frames) {
  if (await clickIf(frame, /ready up|^ready$/i, 150_000)) readyCount += 1;
}
note("ready", { readyCount });
await page.waitForTimeout(1_500);
await shot("tour-round-02b-lobby-ready.png");
const started = (await clickIf(p1, /start the round/i, 15_000)) || (await clickIf(p2, /start the round/i, 5_000));
note("start", { started });

// Wait out load + role reveal, then find which pane is the mimic.
let mimic = null;
let inspector = null;
for (let step = 0; step < 40; step += 1) {
  await page.waitForTimeout(4_000);
  const t1 = await textOf(p1);
  const t2 = await textOf(p2);
  if (/collapse forge tools|forge ·/i.test(t1)) {
    mimic = { frame: p1, index: 0 };
    inspector = { frame: p2, index: 1 };
    break;
  }
  if (/collapse forge tools|forge ·/i.test(t2)) {
    mimic = { frame: p2, index: 1 };
    inspector = { frame: p1, index: 0 };
    break;
  }
}
note("roles", { dealt: mimic !== null, mimicPane: mimic === null ? null : mimic.index + 1 });
await shot("tour-round-03-roles.png");

if (mimic !== null && inspector !== null) {
  const m = mimic.frame;

  // First-round guide should be up in both panes at the start of a new game.
  note("guide", {
    mimicGuide: /first round/i.test(await textOf(m)),
    inspectorGuide: /first round/i.test(await textOf(inspector.frame)),
  });

  // FORGE: movement, every tool, mirror, preset, undo/redo, collapse cycle.
  await drive(mimic.index, ["w"], 900);
  await drive(mimic.index, [" "], 250);
  await drive(mimic.index, ["a"], 500);
  for (const key of ["1", "2", "3", "4"]) {
    const centre = await paneCanvasCentre(mimic.index);
    if (centre !== null) await page.mouse.click(centre.x, centre.y);
    await page.keyboard.press(key);
    await page.waitForTimeout(700);
    note(`tool-${key}`, { text: (await textOf(m)).split("\n").slice(0, 12) });
  }
  await shot("tour-round-04-forge-tools.png");
  await clickIf(m, /compact/i);
  await page.keyboard.press("m");
  await page.waitForTimeout(400);
  await clickIf(m, /undo/i);
  await clickIf(m, /redo/i);

  // The collapse/expand cycle that used to wedge (fixed 2026-08-05).
  const collapsed = await clickIf(m, /collapse forge tools/i);
  await page.waitForTimeout(600);
  const expanded = await clickIf(m, /expand forge tools/i);
  note("toggle-cycle", { collapsed, expanded });

  // Paint: open the panel, drag one stroke across the body, undo it.
  const centre = await paneCanvasCentre(mimic.index);
  if (centre !== null) await page.mouse.click(centre.x, centre.y);
  await page.keyboard.press("5");
  await page.waitForTimeout(900);
  await shot("tour-round-05-paint.png");
  note("paint", { text: (await textOf(m)).split("\n").slice(0, 20) });
  await dragOnPane(mimic.index, -20, -10, 25, 15);
  await page.waitForTimeout(400);
  await clickIf(m, /undo/i);

  // INSPECTOR: wander the redecorated office and look around.
  await drive(inspector.index, ["w"], 900);
  await drive(inspector.index, [" "], 250);
  await dragOnPane(inspector.index, 0, 0, 140, -30);
  await page.waitForTimeout(400);
  await shot("tour-round-06-office.png");
  await drive(inspector.index, ["a"], 700);
  await dragOnPane(inspector.index, 0, 0, -220, 10);
  await shot("tour-round-07-office-2.png");
  note("office", { text: (await textOf(inspector.frame)).split("\n").slice(0, 16) });

  // Lock the disguise before the Forge runs out.
  const mc = await paneCanvasCentre(mimic.index);
  if (mc !== null) await page.mouse.click(mc.x, mc.y);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  note("lock", { locked: /disguise locked/i.test(await textOf(m)) });

  // Ride into the hunt.
  let huntSeen = false;
  for (let step = 0; step < 40; step += 1) {
    await page.waitForTimeout(4_000);
    if (/warrants remaining|warrants left/i.test(await textOf(inspector.frame))) {
      huntSeen = true;
      break;
    }
  }
  note("hunt", { huntSeen });
  await shot("tour-round-08-hunt-start.png");

  if (huntSeen) {
    // Mimic: taunt (button and key) and the board toggle.
    const tauntClicked = await clickIf(m, /taunt/i);
    await page.waitForTimeout(700);
    note("taunt", { tauntClicked, caption: /taunt/i.test(await textOf(m)) });
    const boardOpened = await clickIf(m, /missed|board/i);
    await page.waitForTimeout(700);
    await shot("tour-round-09-board.png");
    note("board", { boardOpened, text: (await textOf(m)).split("\n").slice(0, 18) });
    await clickIf(m, /missed|board/i);
    await drive(mimic.index, ["w"], 700);

    // Inspector: walk the shop, sweep the aim, spend one warrant.
    const before = await textOf(inspector.frame);
    const warrantsBefore = before.match(/(\d+)\s*warrants?/i)?.[1] ?? null;
    await drive(inspector.index, ["w"], 2_500);
    const ic = await paneCanvasCentre(inspector.index);
    if (ic !== null) {
      await page.mouse.move(ic.x + 60, ic.y + 40, { steps: 8 });
      await page.waitForTimeout(400);
      await page.mouse.click(ic.x + 60, ic.y + 40);
    }
    await page.waitForTimeout(1_200);
    const after = await textOf(inspector.frame);
    note("shot", {
      warrantsBefore,
      warrantsAfter: after.match(/(\d+)\s*warrants?/i)?.[1] ?? null,
      fired: /warrant fired/i.test(after),
    });
    await shot("tour-round-10-shot.png");
  }

  // Ride to results, then the rematch, checking the guide stays away.
  let resultsSeen = false;
  for (let step = 0; step < 45; step += 1) {
    await page.waitForTimeout(4_000);
    const text = await textOf(p1);
    if (/results|rematch|play again|next round/i.test(text)) {
      resultsSeen = true;
      break;
    }
  }
  note("results", { resultsSeen });
  await shot("tour-round-11-results.png");
  note("results-text", {
    p1: (await textOf(p1)).split("\n").slice(0, 30),
    p2: (await textOf(p2)).split("\n").slice(0, 30),
  });

  if (resultsSeen) {
    for (const frame of frames) await clickIf(frame, /rematch|play again|next round|ready/i, 8_000);
    await page.waitForTimeout(8_000);
    await shot("tour-round-12-rematch.png");
    note("round2-guide", {
      guideVisibleRound2: /first round/i.test(await textOf(p1)) || /first round/i.test(await textOf(p2)),
      text: (await textOf(p1)).split("\n").slice(0, 14),
    });
  }
}

process.stdout.write(JSON.stringify(report, null, 2));
await context.close();
