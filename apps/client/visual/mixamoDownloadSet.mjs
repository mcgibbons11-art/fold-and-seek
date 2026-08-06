/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const profile = process.env.FOLDSEEK_AUTH_PROFILE;
if (!profile) throw new Error("FOLDSEEK_AUTH_PROFILE is required");
const outputDir = path.resolve(process.cwd(), "../../assets-source/mixamo/raw");
await fs.mkdir(outputDir, { recursive: true });

const allClips = [
  { slug: "run", query: "Running", description: "Running With Intention", inPlace: true },
  { slug: "idle", query: "Looking Over Both Shoulders", description: "Looking Over Both Shoulders", inPlace: false },
  { slug: "jump", query: "Jumping In Place", description: "Jumping In Place", inPlace: true },
  { slug: "climb", query: "Ladder Climb One Step At A Time", description: "Ladder Climb One Step At A Time", inPlace: true },
  { slug: "taunt", query: "Taunting Pointing At Wrist", description: "Taunting Pointing At Wrist", inPlace: false },
  { slug: "hit", query: "Male Reaction Hit On The Left Side", description: "Male Reaction Hit On The Left Side", inPlace: false },
  { slug: "death", query: "Dying With Front Impact To The Head And Fall On One Knee", description: "Dying With Front Impact To The Head And Fall On One Knee", inPlace: false },
  { slug: "rifle-idle", query: "Rifle Standing Aiming Idle", description: "Rifle Standing Aiming Idle", inPlace: true },
  { slug: "rifle-fire", query: "Firing A Rifle While Standing", description: "Firing A Rifle While Standing", inPlace: true },
];
const only = process.env.FOLDSEEK_MIXAMO_ONLY;
const clips = only ? allClips.filter((clip) => clip.slug === only) : allClips;

const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome", headless: true, viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  args: ["--profile-directory=Default", "--disable-background-networking"],
});
const page = context.pages()[0] ?? (await context.newPage());

async function downloadClip(clip) {
  await page.goto("about:blank");
  await page.goto("https://www.mixamo.com/#/?page=1&type=Motion%2CMotionPack", {
    waitUntil: "domcontentloaded", timeout: 60_000,
  });
  await page.waitForTimeout(3_500);
  const search = page.locator('input[type="search"]');
  await search.fill(clip.query);
  await search.press("Enter");
  const card = page.locator(".product-animation").filter({ hasText: `Description: ${clip.description}` }).first();
  await card.waitFor({ timeout: 30_000 });
  await card.click({ force: clip.slug === "climb" });
  await page.waitForTimeout(5_000);

  const inPlaceLabel = page.getByText("In Place", { exact: true });
  if (clip.inPlace && (await inPlaceLabel.count()) > 0) {
    const checkbox = inPlaceLabel.locator("xpath=preceding::input[@type='checkbox'][1]");
    if ((await checkbox.count()) > 0 && !(await checkbox.isChecked())) await checkbox.check({ force: true });
  }

  await page.getByRole("button", { name: "DOWNLOAD" }).first().click();
  const modal = page.locator(".asset-download-modal");
  await modal.waitFor({ state: "visible", timeout: 20_000 });
  const selects = page.locator("select");
  const count = await selects.count();
  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    const values = await select.locator("option").evaluateAll((options) => options.map((option) => option.value));
    if (values.includes("fbx7_2019")) await select.selectOption("fbx7_2019");
    else if (values.includes("true") && values.includes("false")) await select.selectOption("false");
    else if (values.includes("24") && values.includes("30") && values.includes("60")) await select.selectOption("30");
    else if (values.includes("0") && values.includes("1") && values.includes("2")) await select.selectOption("0");
  }
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await modal.getByRole("button", { name: "DOWNLOAD" }).click();
  const download = await downloadPromise;
  const destination = path.join(outputDir, `${clip.slug}.fbx`);
  await download.saveAs(destination);
  process.stdout.write(`downloaded ${clip.slug} -> ${destination}\n`);
}

const failures = [];
for (const clip of clips) {
  try {
    await downloadClip(clip);
  } catch (error) {
    failures.push({ slug: clip.slug, message: error instanceof Error ? error.message : String(error) });
    process.stdout.write(`failed ${clip.slug}: ${failures.at(-1).message}\n`);
    const cancel = page.getByRole("button", { name: "CANCEL" });
    if ((await cancel.count()) > 0) await cancel.last().click({ force: true }).catch(() => undefined);
  }
}
await context.close();
if (failures.length > 0) {
  process.stdout.write(`${JSON.stringify({ failures }, null, 2)}\n`);
  process.exitCode = 1;
}
