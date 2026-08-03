/* global process, window */

import { chromium } from "@playwright/test";
import path from "node:path";

const baseUrl = process.env.FOLDSEEK_VISUAL_URL ?? "http://127.0.0.1:4178/?visualReview";
const outputDir = path.resolve(process.cwd(), "../.playwright-mcp");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on("console", (message) => {
  if (message.type() === "error") process.stderr.write(`[browser] ${message.text()}\n`);
});

// The local Vite page is outside the Portals host. Supply the documented SDK
// shape so the screenshots can also reach the real matchmaking destination.
await page.addInitScript(() => {
  const self = {
    id: "visual-seat",
    playerId: "visual-player",
    displayName: "Visual Curator",
    avatarUrl: null,
  };
  const state = {};
  const listeners = new Map();
  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  window.Portals = {
    version: "visual-review",
    ready: async () => ({
      context: "room",
      player: { playerId: self.playerId, displayName: self.displayName, avatarUrl: null },
    }),
    net: {
      join: async () => ({ self, players: [self], state: { ...state } }),
      leave: async () => {},
      send: () => {},
      setState: (key, value) => {
        state[key] = value;
        emit("state", key, value);
      },
      getState: (key) => (key === undefined ? { ...state } : state[key]),
      players: () => [self],
      self: () => self,
      on: (event, listener) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      },
      off: (event, listener) => listeners.get(event)?.delete(listener),
    },
  };
});

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Enter the shop" }).waitFor({ timeout: 30_000 });
await page.screenshot({ path: path.join(outputDir, "menu-start-redesign.png") });

await page.getByRole("button", { name: "Enter the shop" }).click();
await page.getByLabel("Main menu").waitFor();
await page.waitForTimeout(550);
await page.screenshot({ path: path.join(outputDir, "menu-command-redesign.png") });

await page.getByRole("button", { name: "How to play" }).click();
const hotkeysHeading = page.getByRole("heading", { name: "Hotkeys" });
await hotkeysHeading.waitFor();
await hotkeysHeading.scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(outputDir, "menu-how-to-play-redesign.png") });
await page.getByRole("button", { name: "Back", exact: true }).click();

await page.getByRole("button", { name: "Settings" }).click();
await page.getByRole("slider", { name: "Master volume" }).waitFor();
await page.waitForTimeout(550);
await page.screenshot({ path: path.join(outputDir, "menu-settings-redesign.png") });
await page.getByRole("button", { name: "Back", exact: true }).click();

await page.getByRole("button", { name: "Matchmaking" }).click();
await page.getByLabel("Matchmaking lobby").waitFor();
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(outputDir, "menu-matchmaking-redesign.png") });

await page.setViewportSize({ width: 760, height: 900 });
await page.screenshot({ path: path.join(outputDir, "menu-matchmaking-narrow.png") });
await browser.close();
