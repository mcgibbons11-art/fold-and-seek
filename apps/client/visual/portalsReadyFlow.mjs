/* global process, HTMLCanvasElement, KeyboardEvent */

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
const errors = [];
page.on("console", (message) => {
  const output = message.text();
  if (
    message.type() === "error" ||
    (message.type() === "warning" && /audio|notallowed|refused|focus target|unknown/i.test(output))
  ) errors.push(`console ${message.type()}: ${output}`);
});
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});

await page.goto("https://portals.to/editor/g69147a46cb26443db7723cd0", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
const reject = page.getByRole("button", { name: "Reject all" });
if (await reject.isVisible().catch(() => false)) await reject.click();
await page.waitForTimeout(30_000);
let frames = page.frames().filter((frame) => /arcade\.portals\.to\/drafts\/editor/.test(frame.url()));
if (frames.length !== 2) {
  await page.getByRole("button", { name: /^2p$/i }).click();
  const twoPlayerDeadline = Date.now() + 60_000;
  while (frames.length !== 2 && Date.now() < twoPlayerDeadline) {
    await page.waitForTimeout(1_000);
    frames = page.frames().filter((frame) =>
      /arcade\.portals\.to\/drafts\/editor/.test(frame.url()),
    );
  }
}
if (frames.length !== 2) throw new Error(`Expected two player frames, found ${frames.length}`);
for (const frame of frames) {
  await frame.getByRole("button", { name: /enter the shop/i }).click();
  await frame.getByRole("button", { name: /^matchmaking$/i }).click();
}
await page.waitForTimeout(1_000);

// Prove the full-screen route has a keyboard-focusable escape and can be
// re-entered without losing the authenticated Portals session.
const returnButton = frames[1].getByRole("button", { name: /^return to main menu$/i });
await returnButton.focus();
if (!(await returnButton.evaluate((node) => node === globalThis.document.activeElement))) {
  throw new Error("Matchmaking return control could not receive keyboard focus");
}
await returnButton.click();
await frames[1].getByRole("button", { name: /^matchmaking$/i }).waitFor();
await frames[1].getByRole("button", { name: /^matchmaking$/i }).click();

const matchmakingLayout = await Promise.all(
  frames.map(async (frame, index) => ({
    player: index + 1,
    horizontalOverflow: await frame.locator("html").evaluate(
      (node) => node.scrollWidth > node.clientWidth + 1,
    ),
    viewport: await frame.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    })),
  })),
);
if (matchmakingLayout.some((entry) => entry.horizontalOverflow)) {
  throw new Error(`Matchmaking overflowed its Portals pane: ${JSON.stringify(matchmakingLayout)}`);
}
await page.screenshot({ path: path.join(outputDir, "portals-matchmaking-fullscreen.png"), fullPage: false });

// Cancellation is tested on a disposable listing so it cannot hide behind the
// later leave/return flow of the room used for the full match. The host must
// stay on the matchmaking screen and the vacancy must disappear for both the
// publisher and another authenticated player.
const cancelledRoomName = `Cancel ${Date.now().toString().slice(-6)}`;
await frames[0].getByRole("button", { name: /^custom room and training$/i }).click();
await frames[0].getByRole("textbox", { name: /room name/i }).fill(cancelledRoomName);
await frames[0].getByRole("button", { name: /^new room$/i }).click();
const cancelledHostRow = frames[0].locator("li").filter({ hasText: cancelledRoomName });
const cancelledGuestRow = frames[1].locator("li").filter({ hasText: cancelledRoomName });
await cancelledHostRow.waitFor({ timeout: 10_000 });
await cancelledGuestRow.waitFor({ timeout: 10_000 });
await cancelledHostRow.click();
await frames[0].getByRole("button", { name: /^cancel hosted room$/i }).click();
await cancelledHostRow.waitFor({ state: "detached", timeout: 10_000 });
await cancelledGuestRow.waitFor({ state: "detached", timeout: 10_000 });
const cancelledRoom = {
  name: cancelledRoomName,
  hostListingCount: await cancelledHostRow.count(),
  guestListingCount: await cancelledGuestRow.count(),
  hostStillInMatchmaking: await frames[0]
    .getByRole("button", { name: /^return to main menu$/i })
    .isVisible(),
  canCreateAgain: await frames[0].getByRole("button", { name: /^new room$/i }).isVisible(),
};
if (!cancelledRoom.hostStillInMatchmaking || !cancelledRoom.canCreateAgain) {
  throw new Error(`Cancelling a hosted room left matchmaking: ${JSON.stringify(cancelledRoom)}`);
}

const roomName = `PW ${Date.now().toString().slice(-6)}`;
// The cancellation path leaves this tab selected; clicking is harmless when
// the responsive pane has returned to the room list and necessary otherwise.
const customRoomsTab = frames[0].getByRole("button", { name: /^custom room and training$/i });
if (await customRoomsTab.isVisible().catch(() => false)) await customRoomsTab.click();
await frames[0].getByRole("textbox", { name: /room name/i }).fill(roomName);
await frames[0].getByRole("button", { name: /^new room$/i }).click();
const hostRow = frames[0].locator("li").filter({ hasText: roomName });
await hostRow.waitFor({ timeout: 10_000 });
await hostRow.click();
const guestRow = frames[1].locator("li").filter({ hasText: roomName });
await guestRow.waitFor({ timeout: 10_000 });
await guestRow.click();
await frames[1].getByRole("button", { name: /^request to join$/i }).click();
await frames[0].getByRole("button", { name: /^accept$/i }).waitFor({ timeout: 10_000 });
await page.screenshot({ path: path.join(outputDir, "portals-join-request.png"), fullPage: false });
await frames[0].getByRole("button", { name: /^accept$/i }).click();
await Promise.all(
  frames.map((frame) =>
    frame.getByRole("button", { name: /^ready up$/i }).waitFor({ timeout: 90_000 }),
  ),
);
await page.screenshot({ path: path.join(outputDir, "portals-two-player-ready.png"), fullPage: false });

const lobbyState = [];
for (const [index, frame] of frames.entries()) {
  lobbyState.push({
    player: index + 1,
    text: (await frame.locator("body").innerText()).slice(0, 10_000),
    buttons: await frame.locator("button:visible").evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.innerText.trim(),
        pressed: node.getAttribute("aria-pressed"),
        disabled: node.hasAttribute("disabled"),
        background: globalThis.getComputedStyle(node).backgroundColor,
        color: globalThis.getComputedStyle(node).color,
      })),
    ),
  });
}

const guestReady = frames[1].getByRole("button", { name: /^ready up$/i });
await guestReady.click();
const optimisticGuestReady = frames[1].locator('button[aria-pressed="true"]').first();
const immediateGuestReady = {
  text: await optimisticGuestReady.innerText(),
  pressed: await optimisticGuestReady.getAttribute("aria-pressed"),
  background: await optimisticGuestReady.evaluate(
    (node) => globalThis.getComputedStyle(node).backgroundColor,
  ),
  color: await optimisticGuestReady.evaluate((node) => globalThis.getComputedStyle(node).color),
};
await page.waitForTimeout(2_000);
const acknowledgedGuestReady = {
  text: await frames[1].getByRole("button", { name: /^ready$/i }).innerText(),
  pressed: await frames[1].getByRole("button", { name: /^ready$/i }).getAttribute("aria-pressed"),
  roster: (await frames[0].locator("body").innerText()).match(/ROSTER[\s\S]*$/)?.[0]?.slice(0, 500),
};

await frames[0].getByRole("button", { name: /^ready up$/i }).click();
await page.waitForTimeout(2_000);
const start = frames[0].getByRole("button", { name: /^start the round$/i });
const bothReady = {
  hostPressed: await frames[0].getByRole("button", { name: /^ready$/i }).getAttribute("aria-pressed"),
  guestPressed: await frames[1].getByRole("button", { name: /^ready$/i }).getAttribute("aria-pressed"),
  startDisabled: await start.isDisabled(),
};
await page.screenshot({ path: path.join(outputDir, "portals-both-ready.png"), fullPage: false });
if (!bothReady.startDisabled) await start.click();
// Observe the whole transition rather than checking one late screenshot. The
// old 12-second Baseline/Memorize screen could otherwise appear and disappear
// between assertions while the test was waiting for the shop to finish.
const phaseTransitionSamples = [];
const forbiddenMemorizeScreens = [];
for (let step = 0; step < 20; step += 1) {
  await page.waitForTimeout(500);
  for (const [index, frame] of frames.entries()) {
    const text = (await frame.locator("body").innerText()).slice(0, 8_000);
    phaseTransitionSamples.push({
      elapsedMs: (step + 1) * 500,
      player: index + 1,
      text: text.slice(0, 800),
    });
    if (/baseline\s+scan|memor(?:ize|ise)(?:\s+the)?\s+room|study\s+the\s+room/i.test(text)) {
      forbiddenMemorizeScreens.push({
        elapsedMs: (step + 1) * 500,
        player: index + 1,
        text: text.slice(0, 2_000),
      });
    }
  }
}
if (forbiddenMemorizeScreens.length > 0) {
  throw new Error(
    `Removed Baseline/Memorize screen appeared: ${JSON.stringify(forbiddenMemorizeScreens)}`,
  );
}
const started = await Promise.all(
  frames.map(async (frame, index) => ({
    player: index + 1,
    text: (await frame.locator("body").innerText()).slice(0, 8_000),
  })),
);
await page.screenshot({ path: path.join(outputDir, "portals-round-started.png"), fullPage: false });
const hiderIndex = started.findIndex((entry) => /^FOLD\b/.test(entry.text));
if (hiderIndex < 0) throw new Error("Neither Portals player was assigned Hider");
const hiderFrame = frames[hiderIndex];
const movementNode = hiderFrame.locator("[data-hider-position]").first();
await movementNode.waitFor({ timeout: 5_000 });
const readMovement = async () => ({
  visualId: await movementNode.getAttribute("data-hider-visual-id"),
  position: (await movementNode.getAttribute("data-hider-position")).split(",").map(Number),
  facingYaw: Number(await movementNode.getAttribute("data-hider-facing-yaw")),
  travelYaw: Number(await movementNode.getAttribute("data-hider-travel-yaw")),
  speed: Number(await movementNode.getAttribute("data-hider-speed")),
  climbing: (await movementNode.getAttribute("data-hider-climbing")) === "true",
  grounded: (await movementNode.getAttribute("data-hider-grounded")) === "true",
});
const movementStart = await readMovement();
if (movementStart.visualId !== "mimic-hider-forge-v2") {
  throw new Error(`Hosted Hider visual is stale: ${movementStart.visualId}`);
}
// Portals' two-pane editor retains protocol keyboard focus in its outer shell,
// even when the nested canvas reports itself focused. Dispatch into the actual
// authenticated player window so the game's real listeners and frame loop own
// the held-key duration.
await hiderFrame.getByRole("button", { name: /pose$/i }).click();
const hiderKey = (type, key) =>
  hiderFrame.evaluate(
    ({ type, key }) => globalThis.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true })),
    { type, key },
  );
await hiderKey("keydown", "w");
await page.waitForTimeout(900);
const movementRunning = await readMovement();
const runDistance = Math.hypot(
  movementRunning.position[0] - movementStart.position[0],
  movementRunning.position[2] - movementStart.position[2],
);
const facingDotTravel = Math.cos(movementRunning.facingYaw - movementRunning.travelYaw);
if (runDistance < 0.25 || facingDotTravel < 0.95 || movementRunning.speed <= 0) {
  throw new Error(
    `Hider run did not face and travel forward: ${JSON.stringify({ movementStart, movementRunning, runDistance, facingDotTravel })}`,
  );
}

await hiderKey("keydown", " ");
let climbStarted = null;
let climbFinished = null;
const climbSamples = [];
for (let step = 0; step < 80; step += 1) {
  await page.waitForTimeout(100);
  const sample = await readMovement();
  if (step % 5 === 0) climbSamples.push(sample);
  if (climbStarted === null && sample.climbing) climbStarted = sample;
  if (
    climbStarted !== null &&
    climbFinished === null &&
    !sample.climbing &&
    sample.grounded &&
    sample.position[1] > climbStarted.position[1] + 0.2
  ) {
    climbFinished = sample;
    break;
  }
}
// Releasing Space at the top is the player action that used to leave the
// locomotion state latched forever. Keep W held after release and prove both
// that climb mode stays off and that ordinary movement resumes.
await hiderKey("keyup", " ");
const postTopoutSamples = [];
for (let step = 0; step < 18; step += 1) {
  await page.waitForTimeout(100);
  postTopoutSamples.push(await readMovement());
}
await hiderKey("keyup", "w");
const dismountFinished = postTopoutSamples.at(-1) ?? null;
const postTopoutDistance =
  climbFinished === null || dismountFinished === null
    ? 0
    : Math.hypot(
        dismountFinished.position[0] - climbFinished.position[0],
        dismountFinished.position[1] - climbFinished.position[1],
        dismountFinished.position[2] - climbFinished.position[2],
      );
const stuckAfterTopout = postTopoutSamples.some((sample) => sample.climbing);
if (
  climbStarted === null ||
  climbFinished === null ||
  dismountFinished === null ||
  stuckAfterTopout ||
  postTopoutDistance < 0.12
) {
  throw new Error(
    `Hider did not release climb and resume movement after top-out: ${JSON.stringify({ climbStarted, climbFinished, dismountFinished, postTopoutDistance, stuckAfterTopout, climbSamples, postTopoutSamples })}`,
  );
}
const hiderTraversal = {
  start: movementStart,
  running: movementRunning,
  runDistance,
  facingDotTravel,
  climbStarted,
  climbFinished,
  dismountFinished,
  postTopoutDistance,
  stuckAfterTopout,
  samples: climbSamples,
  postTopoutSamples,
};
await page.screenshot({ path: path.join(outputDir, "portals-hider-topout.png"), fullPage: false });
await hiderFrame.getByRole("button", { name: /paint$/i }).click();
await hiderFrame.getByRole("button", { name: /mirror$/i }).click();
const paintPanel = hiderFrame.locator("[data-paint-stroke-count]");
await paintPanel.waitFor({ timeout: 5_000 });
await page.screenshot({ path: path.join(outputDir, "portals-paint-mode.png"), fullPage: false });
const paintViewport = await hiderFrame.evaluate(() => {
  const canvas = globalThis.document.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Hider canvas missing");
  const rect = canvas.getBoundingClientRect();
  return {
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
});
// The editor scales its two embedded players independently, so window-relative
// guesses drift. Probe the unobstructed middle of the actual render canvas;
// mirrored limbs yield two stamps, while a centre-body hit yields one and is
// cleared before the next probe.
const paintCandidates = [0.35, 0.42, 0.49, 0.56, 0.63, 0.7].flatMap((yShare) =>
  [0.36, 0.43, 0.5, 0.57, 0.64].map((xShare) => [xShare, yShare]),
);
const paintAttempts = [];
for (const [xShare, yShare] of paintCandidates) {
  const x = paintViewport.canvas.left + paintViewport.canvas.width * xShare;
  const y = paintViewport.canvas.top + paintViewport.canvas.height * yShare;
  // A synthetic PointerEvent is not an active browser pointer, so
  // setPointerCapture correctly rejects it before the brush can stamp. A
  // Playwright click goes through Chrome's input path exactly like a player.
  await hiderFrame.locator("canvas").first().click({
    position: {
      x: paintViewport.canvas.width * xShare,
      y: paintViewport.canvas.height * yShare,
    },
    force: true,
  });
  await page.waitForTimeout(100);
  const count = Number(await paintPanel.getAttribute("data-paint-stroke-count"));
  paintAttempts.push({ x: Math.round(x), y: Math.round(y), count });
  if (count === 2) break;
  if (count > 0) {
    await hiderFrame.getByRole("button", { name: /clear$/i }).click();
    await hiderFrame.getByRole("button", { name: /^sure\?$/i }).click();
    await page.waitForTimeout(100);
  }
}
const mirrorPaint = {
  viewport: paintViewport,
  attempts: paintAttempts,
  finalCount: Number(await paintPanel.getAttribute("data-paint-stroke-count")),
  mirrorPressed: await hiderFrame
    .getByRole("button", { name: /mirror$/i })
    .getAttribute("aria-pressed"),
  mirrorStatusVisible: await hiderFrame.getByText(/^mirror$/i).count(),
};
if (mirrorPaint.finalCount !== 2) {
  throw new Error(`Mirror spray did not produce one paired dab: ${JSON.stringify(mirrorPaint)}`);
}
await page.screenshot({ path: path.join(outputDir, "portals-mirror-spray.png"), fullPage: false });
await hiderFrame.getByRole("button", { name: /lock disguise/i }).click();
await page.waitForTimeout(12_000);
const hunt = await Promise.all(
  frames.map(async (frame, index) => ({
    player: index + 1,
    text: (await frame.locator("body").innerText()).slice(0, 8_000),
  })),
);
await page.screenshot({ path: path.join(outputDir, "portals-hunt-open.png"), fullPage: false });
await page.waitForTimeout(55_000);
const inspection = await Promise.all(
  frames.map(async (frame, index) => ({
    player: index + 1,
    text: (await frame.locator("body").innerText()).slice(0, 8_000),
  })),
);
await page.screenshot({ path: path.join(outputDir, "portals-inspection-live.png"), fullPage: false });
const inspectorIndex = hiderIndex === 0 ? 1 : 0;
const inspectorFrame = frames[inspectorIndex];
const inspectorCanvas = inspectorFrame.locator("canvas").first();
const canvasBox = await inspectorCanvas.boundingBox();
if (canvasBox === null) throw new Error("Inspector canvas has no live bounds");
await inspectorCanvas.evaluate((canvas) => {
  // Portals' two-pane editor preview intentionally declines browser pointer
  // lock. Emulate only that browser-owned bit for automated input; all game
  // controller, focus, weapon, transport, and authority code remains real.
  Object.defineProperty(globalThis.document, "pointerLockElement", {
    configurable: true,
    get: () => canvas,
  });
  globalThis.document.dispatchEvent(new globalThis.Event("pointerlockchange"));
});
await page.waitForTimeout(500);
await inspectorCanvas.waitFor({ state: "visible" });
const readInspector = async () => ({
  position: (await inspectorCanvas.getAttribute("data-inspector-position")).split(",").map(Number),
  yaw: Number(await inspectorCanvas.getAttribute("data-inspector-yaw")),
});
await inspectorFrame.evaluate(() => {
  globalThis.document.dispatchEvent(
    new globalThis.KeyboardEvent("keydown", { code: "KeyW", key: "w", bubbles: true }),
  );
  globalThis.document.dispatchEvent(
    new globalThis.KeyboardEvent("keydown", {
      code: "ShiftLeft",
      key: "Shift",
      bubbles: true,
    }),
  );
});
const hiderTarget = hiderTraversal.dismountFinished.position;
const inspectorWaypoints = [
  [4.55, 3.6],
  [3, 2],
  [1, 0],
  [0, -2.4],
  [hiderTarget[0], hiderTarget[2]],
];
const inspectorRoute = [];
for (const [targetX, targetZ] of inspectorWaypoints) {
  for (let step = 0; step < 70; step += 1) {
    const current = await readInspector();
    const dx = targetX - current.position[0];
    const dz = targetZ - current.position[2];
    const distance = Math.hypot(dx, dz);
    if (distance < (targetX === hiderTarget[0] ? 0.85 : 0.45)) break;
    const wantedYaw = Math.atan2(-dx, -dz);
    const yawDelta = Math.atan2(Math.sin(wantedYaw - current.yaw), Math.cos(wantedYaw - current.yaw));
    await inspectorFrame.evaluate((movementX) => {
      globalThis.document.dispatchEvent(
        new globalThis.MouseEvent("mousemove", { movementX, movementY: 0, bubbles: true }),
      );
    }, -yawDelta / 0.0022);
    await page.waitForTimeout(100);
  }
  inspectorRoute.push({ waypoint: [targetX, targetZ], reached: await readInspector() });
}
await inspectorFrame.evaluate(() => {
  globalThis.document.dispatchEvent(
    new globalThis.KeyboardEvent("keyup", { code: "KeyW", key: "w", bubbles: true }),
  );
  globalThis.document.dispatchEvent(
    new globalThis.KeyboardEvent("keyup", {
      code: "ShiftLeft",
      key: "Shift",
      bubbles: true,
    }),
  );
});
await page.waitForTimeout(500);
const inspectorAtTarget = await readInspector();
const inspectorTargetDistance = Math.hypot(
  inspectorAtTarget.position[0] - hiderTarget[0],
  inspectorAtTarget.position[2] - hiderTarget[2],
);
if (inspectorTargetDistance > 1.1) {
  throw new Error(
    `Inspector could not navigate into warrant range: ${JSON.stringify({ inspectorRoute, inspectorAtTarget, hiderTarget, inspectorTargetDistance })}`,
  );
}
await inspectorCanvas.dispatchEvent("mousedown", { button: 2, bubbles: true });
const acquiredTargets = [];
let shotTarget = null;
for (let step = 0; step < 50; step += 1) {
  await inspectorFrame.evaluate(() => {
    globalThis.document.dispatchEvent(
      new globalThis.MouseEvent("mousemove", { movementX: 58, movementY: 0, bubbles: true }),
    );
  });
  await page.waitForTimeout(50);
  const sight = inspectorFrame.locator("[data-target-object-id]").first();
  const objectId = await sight.getAttribute("data-target-object-id").catch(() => null);
  if (!objectId) continue;
  const inRange = await sight.getAttribute("data-target-in-range");
  if (!acquiredTargets.some((entry) => entry.objectId === objectId)) {
    acquiredTargets.push({ step, objectId, inRange });
  }
  if (objectId.startsWith("obj_") && inRange === "true") {
    await inspectorCanvas.dispatchEvent("mousedown", { button: 0, bubbles: true });
    await inspectorCanvas.dispatchEvent("mouseup", { button: 0, bubbles: true });
    shotTarget = objectId;
    break;
  }
}
await inspectorCanvas.dispatchEvent("mouseup", { button: 2, bubbles: true });
await page.waitForTimeout(2_000);
const afterShot = await Promise.all(
  frames.map(async (frame, index) => ({
    player: index + 1,
    text: (await frame.locator("body").innerText()).slice(0, 8_000),
  })),
);
await page.screenshot({ path: path.join(outputDir, "portals-inspector-target-scan.png"), fullPage: false });

// A failed rematch is the exact path that used to leave a remote player's
// private ready flag stuck on the previous round. Exercise it over Portals'
// real relay, then prove the guest can issue a fresh ready command.
await Promise.all(
  frames.map((frame) =>
    // A randomized Hider spawn may evade the automated sight sweep. In that
    // case validate the same post-round flow after the hunt expires naturally.
    frame.getByRole("button", { name: /^return to lobby$/i }).waitFor({ timeout: 100_000 }),
  ),
);
await Promise.all(
  frames.map((frame) => frame.getByRole("button", { name: /^return to lobby$/i }).click()),
);
await Promise.all(
  frames.map((frame) =>
    frame.getByRole("button", { name: /^ready up$/i }).waitFor({ timeout: 25_000 }),
  ),
);
await page.waitForTimeout(1_500);
const returnedLobby = await Promise.all(
  frames.map(async (frame, index) => ({
    player: index + 1,
    readyText: await frame.getByRole("button", { name: /^ready up$/i }).innerText(),
    readyPressed: await frame
      .getByRole("button", { name: /^ready up$/i })
      .getAttribute("aria-pressed"),
    body: (await frame.locator("body").innerText()).slice(0, 3_000),
  })),
);
await frames[1].getByRole("button", { name: /^ready up$/i }).click();
await frames[1].getByRole("button", { name: /^ready$/i }).waitFor({ timeout: 10_000 });
await page.waitForTimeout(1_500);
const guestReready = {
  pressed: await frames[1].getByRole("button", { name: /^ready$/i }).getAttribute("aria-pressed"),
  hostRoster: (await frames[0].locator("body").innerText())
    .match(/ROSTER[\s\S]*$/)?.[0]
    ?.slice(0, 500),
};
await page.screenshot({ path: path.join(outputDir, "portals-rematch-ready-reset.png"), fullPage: false });

// The backquote overlay is deliberately DOM text, not console output, so the
// same authenticated runtime can expose useful figures even when Portals owns
// the outer browser. Read both panes: only the Hider consumes remote Inspector
// samples, but both must report sane frame counters.
const performanceDiagnostics = [];
for (const [index, frame] of frames.entries()) {
  await frame.evaluate(() => {
    globalThis.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Backquote", key: "`", bubbles: true }),
    );
  });
  const overlay = frame.locator("pre:visible").filter({ hasText: "net sample" }).first();
  await overlay.waitFor({ timeout: 5_000 });
  const text = await overlay.innerText();
  const number = (expression, label) => {
    const match = text.match(expression);
    if (match?.[1] === undefined) throw new Error(`Diagnostics missing ${label}: ${text}`);
    return Number(match[1]);
  };
  const entry = {
    player: index + 1,
    frames: number(/frames\s+(\d+)/, "frames"),
    averageFrameMs: number(/frame avg\s+([\d.]+) ms/, "frame average"),
    maxFrameMs: number(/frame max\s+([\d.]+) ms/, "frame maximum"),
    longFrames: number(/slow\/clamp\s+(\d+)/, "slow frames"),
    clampedFrames: number(/slow\/clamp\s+\d+ \/ (\d+)/, "clamped frames"),
    simulationDrops: number(/sim drops\s+(\d+)/, "simulation drops"),
    acceptedSamples: number(/net sample\s+(\d+) ok/, "accepted remote samples"),
    reorderedSamples: number(/net sample\s+\d+ ok · (\d+) reorder/, "reordered samples"),
    extrapolations: number(/net smooth\s+(\d+) extrap/, "remote extrapolations"),
    staleHolds: number(/net smooth\s+\d+ extrap · (\d+) held/, "remote stale holds"),
    text,
  };
  if (
    entry.frames <= 0 ||
    entry.averageFrameMs < 0 ||
    entry.averageFrameMs > entry.maxFrameMs ||
    entry.maxFrameMs > 10_000 ||
    entry.longFrames > entry.frames ||
    entry.clampedFrames > entry.frames ||
    entry.simulationDrops > entry.frames
  ) {
    throw new Error(`Performance diagnostics are not sane: ${JSON.stringify(entry)}`);
  }
  performanceDiagnostics.push(entry);
}
if (!performanceDiagnostics.some((entry) => entry.acceptedSamples > 0)) {
  throw new Error(
    `Neither authenticated pane recorded remote Inspector samples: ${JSON.stringify(performanceDiagnostics)}`,
  );
}
await page.screenshot({ path: path.join(outputDir, "portals-performance-diagnostics.png"), fullPage: false });

process.stdout.write(
  JSON.stringify(
    {
      roomName,
      cancelledRoom,
      matchmakingLayout,
      lobbyState,
      immediateGuestReady,
      acknowledgedGuestReady,
      bothReady,
      phaseTransitionSamples,
      forbiddenMemorizeScreens,
      started,
      hiderTraversal,
      mirrorPaint,
      hunt,
      inspection,
      inspectorIndex,
      inspectorRoute,
      inspectorAtTarget,
      inspectorTargetDistance,
      acquiredTargets,
      shotTarget,
      afterShot,
      returnedLobby,
      guestReready,
      performanceDiagnostics,
      errors: errors.slice(0, 100),
    },
    null,
    2,
  ),
);
await context.close();
