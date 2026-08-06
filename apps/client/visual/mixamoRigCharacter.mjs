/* global process */

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const userDataDir = process.env.FOLDSEEK_AUTH_PROFILE;
const uploadPath = process.env.FOLDSEEK_MIXAMO_UPLOAD;
const slug = process.env.FOLDSEEK_MIXAMO_SLUG ?? "character";
if (!userDataDir || !uploadPath) throw new Error("profile and upload path are required");

const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
await fs.mkdir(outputDir, { recursive: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
  args: ["--profile-directory=Default", "--disable-background-networking"],
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://www.mixamo.com/#/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4_000);
await page.getByRole("button", { name: "UPLOAD CHARACTER" }).click();
await page.locator('input[type="file"]').setInputFiles(uploadPath);
await page.getByText("AUTO-RIGGER").waitFor({ timeout: 60_000 });
await page.getByText(/^Orient$/).waitFor({ timeout: 60_000 });
await page.waitForTimeout(2_000);
await page.getByRole("button", { name: "NEXT" }).click();
await page.getByText("Place markers", { exact: true }).waitFor({ timeout: 30_000 });
await page.waitForTimeout(1_000);

// Marker centres measured against Mixamo's fixed 1440x1000 autorigger stage.
// The uploaded source is centered front-on and uses the same authored bounds on every run.
const destinations = [
  [595, 282], // chin
  [395, 313], [795, 313], // wrists
  [493, 313], [697, 313], // elbows
  [562, 510], [628, 510], // knees
  [595, 438], // groin
];
const markers = page.locator(".autorig-marker");
if ((await markers.count()) !== destinations.length) {
  throw new Error(`expected ${destinations.length} autorig markers, found ${await markers.count()}`);
}
for (let index = 0; index < destinations.length; index += 1) {
  const marker = markers.nth(index);
  const box = await marker.boundingBox();
  if (!box) throw new Error(`marker ${index} has no bounding box`);
  const [x, y] = destinations[index];
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

await page.locator("select").last().selectOption({ label: "No Fingers (25)" });
await page.screenshot({ path: path.join(outputDir, `${slug}-mixamo-markers.png`) });
process.stdout.write("markers-submitted\n");
await page.getByRole("button", { name: "NEXT" }).click();

await page.waitForFunction(() => {
  const text = document.body.innerText;
  return /successfully (?:auto-?)?rigged|unable to map|auto-rigging failed|something went wrong/i.test(text);
}, undefined, { timeout: 180_000 });
await page.waitForTimeout(2_000);
await page.screenshot({ path: path.join(outputDir, `${slug}-mixamo-rig-result.png`) });
const resultText = (await page.locator("body").innerText()).slice(-3_000);
process.stdout.write(`rig-result\n${resultText}\n`);

if (/successfully (?:auto-?)?rigged/i.test(resultText)) {
  const next = page.getByRole("button", { name: "NEXT" });
  if ((await next.count()) > 0) {
    await next.last().click();
    await page.waitForTimeout(8_000);
  }
  await page.screenshot({ path: path.join(outputDir, `${slug}-mixamo-saved.png`) });
  process.stdout.write("character-saved\n");
}

await context.close();
/* global document */
