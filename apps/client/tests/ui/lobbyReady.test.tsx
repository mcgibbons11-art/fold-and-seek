// @vitest-environment jsdom
import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import { act, useCallback, useSyncExternalStore, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPortalsRound,
  PORTALS_ROUND_CHANNEL,
  type PortalsRound,
} from "../../src/gameplay/portalsRound";
import { RoundActions } from "../../src/gameplay/RoundActions";
import type { RoundDirector } from "../../src/gameplay/RoundDirector";
import { LobbyHud } from "../../src/ui/rounds/LobbyHud";
import { FakePortalsRelay } from "../networking/fakePortals";

/**
 * Readying up in a Portals room, pressed as a player presses it: a real click on
 * the real button, delivered through the store subscription `RoundHud` mounts
 * the lobby with, into the real adapter, simulation and director.
 *
 * The room it opens is the one the editor preview opens — one person, who is
 * also the host and therefore the authority, with the rest of the seats filled
 * by bots. That combination is what task #33 was reported against, and it is the
 * one arrangement the transport tests never covered: they all seat two people.
 *
 * Every link in the chain is deliberately the shipping one, because the defect
 * could live in any of them. A hand-written view state would prove the button
 * calls its handler and nothing else; re-rendering by hand between clicks (which
 * is what `lobbyBots.test.tsx` does) would skip the subscription that is the
 * only reason the lobby redraws in the game.
 */

const FAST_SETTINGS: MatchSettingsPatch = {
  mapIntroMs: 200,
  roleRevealMs: 200,
  baselineScanMs: 200,
  forgeMs: 600,
  lockGraceMs: 200,
  inspectionIntroMs: 200,
  inspectionMs: 2_000,
  revealMs: 200,
  resultsMs: 200,
  rematchVoteMs: 200,
};

const STEP_MS = 100;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

/** The lobby as `RoundHud` mounts it: subscribed to the director, nothing else. */
function SubscribedLobby({
  director,
  actions,
}: {
  readonly director: RoundDirector;
  readonly actions: RoundActions;
}): ReactElement {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => director.subscribe(listener), [director]),
    useCallback(() => director.getState(), [director]),
  );
  return (
    <LobbyHud
      state={state}
      roomCode=""
      onReady={(ready) => actions.ready(ready)}
      onStart={() => actions.startMatch()}
      onAddBot={() => actions.addBot()}
      onRemoveBot={() => actions.removeBot()}
    />
  );
}

function buttonWithText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  );
  if (!found) throw new Error(`no button reading "${text}"`);
  return found;
}

describe("readying up in a Portals lobby", () => {
  it("flips the host's own row and unlocks the start", async () => {
    vi.useFakeTimers();
    let clock = 1_700_000_000_000;
    const relay = new FakePortalsRelay();
    const round: PortalsRound = createPortalsRound({
      sdk: relay.createPeer({ id: "peer-a", displayName: "Ada", playerId: "peer-a" }),
      seed: 5,
      settings: FAST_SETTINGS,
      now: () => clock,
    });
    await round.adapter.connect();
    await round.adapter.join(PORTALS_ROUND_CHANNEL, "Ada");
    const actions = new RoundActions(round.adapter, round.director);

    const advance = (steps = 1): void => {
      act(() => {
        for (let index = 0; index < steps; index += 1) {
          clock += STEP_MS;
          round.adapter.tick();
        }
      });
    };

    // The preview's room: this client holds the simulation, and the seats it
    // cannot fill with people it fills with bots.
    expect(round.adapter.isAuthority()).toBe(true);
    act(() => {
      root.render(<SubscribedLobby director={round.director} actions={actions} />);
    });
    act(() => {
      buttonWithText("+").click();
      buttonWithText("+").click();
    });
    advance(2);

    const before = round.director.getState();
    expect(before.phase).toBe(MatchPhase.Lobby);
    expect(before.roster).toHaveLength(3);
    // The bots ready themselves on the first tick they are seated for, so the
    // one seat still waiting is the one holding the button.
    expect(before.roster.filter((player) => player.ready)).toHaveLength(2);
    expect(before.actions.ready.allowed).toBe(true);
    expect(buttonWithText("Ready up").disabled).toBe(false);
    expect(buttonWithText("Start the round").disabled).toBe(true);

    act(() => {
      buttonWithText("Ready up").click();
    });

    // Nothing is advanced between the click and these: the host runs the
    // simulation in its own page, so its own command resolves before the call
    // that delivered it returns.
    const after = round.director.getState();
    expect(after.self.ready).toBe(true);
    expect(after.roster.find((player) => player.isSelf)?.ready).toBe(true);
    expect(after.actions.startMatch).toEqual({ allowed: true, reason: null });
    expect(after.rejections).toEqual([]);

    // And the lobby the player is looking at says so, which is the half a view
    // state cannot vouch for on its own.
    expect(buttonWithText("Ready").disabled).toBe(false);
    expect(buttonWithText("Start the round").disabled).toBe(false);
    expect(container.textContent).toContain("3 / 3 ready");

    // The plate holding both controls is reachable, which on a short viewport
    // means it is not pinned to the bottom edge; see below.
    round.dispose();
  });

  it("pins nothing to the bottom edge, where the preview's drawer sits", async () => {
    vi.useFakeTimers();
    let clock = 1_700_000_000_000;
    const relay = new FakePortalsRelay();
    const round: PortalsRound = createPortalsRound({
      sdk: relay.createPeer({ id: "peer-a", displayName: "Ada", playerId: "peer-a" }),
      seed: 5,
      settings: FAST_SETTINGS,
      now: () => clock,
    });
    await round.adapter.connect();
    await round.adapter.join(PORTALS_ROUND_CHANNEL, "Ada");
    const actions = new RoundActions(round.adapter, round.director);
    clock += STEP_MS;

    act(() => {
      root.render(<SubscribedLobby director={round.director} actions={actions} />);
    });

    // Measured in the Portals editor on 2026-08-02: the preview-debug drawer is
    // painted over the bottom 180 px of the game's iframe at z-index 30, so a
    // control the lobby anchors to `bottom` is visible through the gap above it
    // and takes none of the clicks aimed at it. A mobile toolbar owns the same
    // band. jsdom does no layout, so the invariant is stated where it is
    // decided — in the styles the lobby writes — rather than in a rect.
    const anchored = [...container.querySelectorAll<HTMLElement>("*")].filter(
      (element) => element.style.bottom !== "",
    );
    expect(anchored.map((element) => element.outerHTML.slice(0, 90))).toEqual([]);

    // And the column it stacks into is anchored to the top edge.
    const column = container.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(column?.style.top).toBe("16px");

    // The controls come before the roster, and the roster is the plate that
    // scrolls. Together those keep Ready and Start at the same height whatever
    // the room holds: a roster that pushed them down would walk them back into
    // the band the drawer owns as soon as the room filled up.
    const text = container.textContent ?? "";
    expect(text.indexOf("Ready up")).toBeLessThan(text.indexOf("Roster"));
    const scrollers = [...container.querySelectorAll<HTMLElement>("*")].filter(
      (element) => element.style.overflowY === "auto",
    );
    expect(scrollers.some((element) => (element.textContent ?? "").includes("Roster"))).toBe(true);

    round.dispose();
  });
});
