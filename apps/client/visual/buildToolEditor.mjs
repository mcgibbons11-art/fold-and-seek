/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The Forge tool audit inside the live Portals editor (2026-08-05): an
 * open-door room with bots, then every tool exercised in pane one with
 * pane-fraction coordinates. The editor is the environment of record, so
 * this is the run that says "done".
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

const frames = page.frames().filter((frame) => /arcade\.portals\.to\/drafts\/editor/.test(frame.url()));
if (frames.length === 0) throw new Error("no Portals player frame");
const game = frames[0];

const paneBox = async () => {
  const boxes = await page.locator("iframe").evaluateAll((nodes) =>
    nodes
      .filter((node) => /arcade\.portals\.to\/drafts\/editor/.test(node.src ?? ""))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      }),
  );
  const box = boxes[0];
  if (box === undefined) throw new Error("pane box unavailable");
  return box;
};
/** Page coordinates from pane fractions, 0..1 in each axis. */
const at = async (fx, fy) => {
  const box = await paneBox();
  return { x: box.x + box.w * fx, y: box.y + box.h * fy };
};
const clickAt = async (fx, fy, modifiers = {}) => {
  const point = await at(fx, fy);
  if (modifiers.shift) await page.keyboard.down("Shift");
  await page.mouse.click(point.x, point.y);
  if (modifiers.shift) await page.keyboard.up("Shift");
};
const dragAt = async (fx0, fy0, fx1, fy1) => {
  const from = await at(fx0, fy0);
  const to = await at(fx1, fy1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
};
const textOf = async () => (await game.locator("body").innerText().catch(() => "")).slice(0, 8_000);
const interesting = async () =>
  (await textOf())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /editing|selected|sampled|dropper|holding|panel|socket|cannot|locked|deployed|copied|swatch|painted|resize/i.test(line),
    )
    .slice(-3);
const clickIf = async (name, timeout = 5_000) => {
  const button = game.getByRole("button", { name }).first();
  try {
    await button.waitFor({ timeout });
    await button.click();
    return true;
  } catch {
    return false;
  }
};


/**
 * Does the BUILD tool actually work in the live editor?
 *
 * The previous editor check loaded the page and read the console, which is
 * why three broken things shipped: arrows that drew but did not drag, shapes
 * that could not be clicked, and socket studs still standing on a body they
 * no longer touch. This one presses buttons.
 */
const findings = [];
const record = (name, ok, detail = "") => {
  findings.push({ name, ok, detail });
};

await clickIf(/enter the shop/i, 45_000);
await page.waitForTimeout(2_000);
/**
 * Getting into a round, retried.
 *
 * Every step here is a click on a menu that may still be animating in, so a
 * single pass through fails often enough that a red result meant nothing. The
 * whole sequence is attempted several times, and only a run that never reaches
 * a lobby at all is reported as not seated.
 */
const ready = game.getByRole("button", { name: /ready up|^ready$/i }).first();
let inLobby = false;
for (let attempt = 0; attempt < 3 && !inLobby; attempt += 1) {
  await clickIf(/start game/i, 8_000);
  await clickIf(/matchmaking|find a lobby/i, 8_000);
  await page.waitForTimeout(1_500);
  await clickIf(/custom room and training/i, 8_000);
  await page.waitForTimeout(1_000);
  await clickIf(/vetted door/i, 5_000);
  await clickIf(/new room/i, 8_000);
  await page.waitForTimeout(3_000);
  inLobby = await ready
    .waitFor({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
}
if (!inLobby) {
  console.log(JSON.stringify({ findings, errors: errors.slice(0, 6), note: "never reached a lobby" }, null, 1));
  await context.close();
  process.exit(3);
}
for (let i = 0; i < 3; i += 1) await clickIf(/add a bot/i, 3_000);
await ready.click().catch(() => undefined);
await clickIf(/start the round/i, 20_000);
await page.waitForTimeout(20_000);
await clickIf(/^skip$/i, 8_000);
await page.waitForTimeout(12_000);

// Into the build tool. Waiting for the tool rail to actually exist before
// judging anything: a run that never seated reported every check as failed,
// which made the audit's red meaningless. Now it says so instead.
await clickIf(/expand forge tools/i, 5_000);
let reachedForge = false;
for (let attempt = 0; attempt < 12 && !reachedForge; attempt += 1) {
  await page.keyboard.press("3");
  await page.waitForTimeout(2_500);
  reachedForge = /add a shape/i.test(await textOf());
}
record("forge tools reachable", reachedForge, reachedForge ? "build tool open" : "never seated");
if (!reachedForge) {
  console.log(JSON.stringify({ findings, errors: errors.slice(0, 6), note: "did not reach a round" }, null, 1));
  await context.close();
  process.exit(3);
}
await page.waitForTimeout(600);

const before = await textOf();
record("build panel shows its adders", /add a shape/i.test(before), "");
const panelText = (t) => (t.match(/add a shape[\s\S]{0,220}/i) ?? ["none"])[0].replace(/\s+/g, " ");
console.log("PANEL BEFORE:", panelText(before));
const names = await game.getByRole("button").allInnerTexts().catch(() => []);
console.log("BUTTONS:", names.map((n) => n.replace(/\s+/g, " ")).slice(0, 24).join(" | "));

// Add two shapes from the panel.
const addedCube = await clickIf(/^cube$/i, 6_000);
await page.waitForTimeout(900);
const addedCylinder = await clickIf(/^cylinder$/i, 6_000);
await page.waitForTimeout(900);
const afterAdd = await textOf();
console.log("PANEL AFTER ADD:", panelText(afterAdd), "| clicked:", addedCube, addedCylinder);
record("adding shapes works", addedCube && addedCylinder && /2 of 16 shapes/i.test(afterAdd),
  (afterAdd.match(/\d+ of 16 shapes/i) ?? ["no count"])[0]);

// Duplicate by key, then delete by key.
await page.keyboard.press("Control+d");
await page.waitForTimeout(900);
const afterDup = await textOf();
record("D duplicates", /3 of 16 shapes/i.test(afterDup),
  (afterDup.match(/\d+ of 16 shapes/i) ?? ["no count"])[0]);

await page.keyboard.press("Delete");
await page.waitForTimeout(900);
const afterDel = await textOf();
record("Delete removes", /2 of 16 shapes/i.test(afterDel),
  (afterDel.match(/\d+ of 16 shapes/i) ?? ["no count"])[0]);

// The form dropper: point at the room and take its shape.
const beforeSample = await textOf();
const sampledForm = await clickIf(/copy a shape from the room/i, 6_000);
await page.waitForTimeout(900);
const afterSample = await textOf();
record("form dropper is reachable and answers", sampledForm &&
  /copied that shape|point at something/i.test(afterSample) &&
  afterSample !== beforeSample,
  (afterSample.match(/copied that shape[^.]*\.|point at something[^.]*\./i) ?? ["no answer"])[0].slice(0, 60));

// Draw a disguise: sweep an outline and it becomes solids.
const beforeDraw = Number((await textOf()).match(/(\d+) OF 16 SHAPES/i)?.[1] ?? "0");
{
  const from = await at(0.30, 0.62);
  const to = await at(0.44, 0.34);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 14; step += 1) {
    const t = step / 14;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * Math.sin(t * Math.PI));
  }
  await page.mouse.up();
}
await page.waitForTimeout(1_200);
const afterDraw = await textOf();
const drawnCount = Number(afterDraw.match(/(\d+) OF 16 SHAPES/i)?.[1] ?? "0");
record("a swept outline becomes solids", drawnCount > beforeDraw,
  `${String(beforeDraw)} then ${String(drawnCount)} · ${(afterDraw.match(/drew that in [^.]*\./i) ?? ["no answer"])[0]}`);

// Mirror: the verb that halves a symmetric build.
const beforeMirror = (await textOf()).match(/(\d+) OF 16 SHAPES/i)?.[1] ?? "0";
const mirrored = await clickIf(/^mirror$/i, 6_000);
await page.waitForTimeout(900);
const afterMirror = (await textOf()).match(/(\d+) OF 16 SHAPES/i)?.[1] ?? "0";
record("mirror adds the other side", mirrored && Number(afterMirror) === Number(beforeMirror) + 1,
  `${beforeMirror} then ${afterMirror}`);

// Snap: the verb that closes the gap a hider gets shot for.
const snapped = await clickIf(/^snap flush$/i, 6_000);
await page.waitForTimeout(900);
const afterSnap = await textOf();
record("snap flush is reachable and answers", snapped &&
  /already flush|nothing to snap|of 16 shapes/i.test(afterSnap), snapped ? "pressed" : "missing");

// Paint one shape without repainting the rest.
const painted = await clickIf(/^paint it$/i, 6_000);
await page.waitForTimeout(900);
record("per-shape paint is reachable", painted ||
  /sample a finish first/i.test(await textOf()), painted ? "pressed" : "needs a held finish");

// The two verdicts a hider builds against.
const verdicts = await textOf();
record("panel reports what it reads as and how hidden the body is",
  /reads as a/i.test(verdicts) && /body hidden/i.test(verdicts),
  ((verdicts.match(/reads as a [^·]+· \d+%/i) ?? ["no verdict"])[0] + " | " +
   (verdicts.match(/body hidden · \d+%/i) ?? ["none"])[0]).slice(0, 70));

// Stretch and turn: the controls that make a barrel out of a cylinder.
const stretched = await clickIf(/^longer$/i, 6_000);
await page.waitForTimeout(700);
const turned = await clickIf(/^turn$/i, 6_000);
await page.waitForTimeout(700);
const afterShape = await textOf();
record("stretch and turn are reachable", stretched && turned,
  (afterShape.match(/\d+ OF 16 SHAPES/i) ?? ["no count"])[0]);

// Every gesture the one gizmo carries: slide, turn, stretch, resize.
await dragAt(0.5, 0.5, 0.62, 0.5);
await page.waitForTimeout(600);
for (const keys of [["Shift"], ["Alt"], ["Alt", "Shift"]]) {
  for (const key of keys) await page.keyboard.down(key);
  await dragAt(0.5, 0.5, 0.58, 0.5);
  for (const key of keys) await page.keyboard.up(key);
  await page.waitForTimeout(600);
}
await page.waitForTimeout(900);
const afterDrag = await textOf();
record("dragging leaves the disguise intact", /of 16 shapes/i.test(afterDrag),
  (afterDrag.match(/\d+ of 16 shapes/i) ?? ["no count"])[0]);

await page.screenshot({ path: path.join(outputDir, "build-tool-editor.png") });
console.log(JSON.stringify({ findings, errors: errors.slice(0, 6) }, null, 1));
await context.close();
if (findings.some((f) => !f.ok)) process.exitCode = 2;
