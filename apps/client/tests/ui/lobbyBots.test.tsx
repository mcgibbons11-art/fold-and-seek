// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RoundActions } from "../../src/gameplay/RoundActions";
import { RoundDirector } from "../../src/gameplay/RoundDirector";
import type { RoundViewState } from "../../src/gameplay/roundView";
import { isBotSeat } from "../../src/networking/botSeats";
import { LocalLoopbackAdapter } from "../../src/networking/LocalLoopbackAdapter";
import { LobbyHud } from "../../src/ui/rounds/LobbyHud";

/**
 * The lobby's bot controls, driven through the real adapter, director and
 * actions rather than a hand-written view state. What is worth proving here is
 * the whole chain: pressing the control seats a player in the simulation, the
 * published roster is what the lobby then draws, and the row it draws says
 * which of the names in it is a machine.
 */

declare global {
  // eslint-disable-next-line no-var
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
});

function buttonLabelled(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
}

function rosterText(): string {
  return container.textContent ?? "";
}

describe("the lobby's bot seats", () => {
  it("seats and gives up a bot through the whole chain, and says which rows are bots", async () => {
    const adapter = new LocalLoopbackAdapter({ seed: 3 });
    const director = new RoundDirector(adapter, { tickIntervalMs: 0 });
    const actions = new RoundActions(adapter, director);
    await adapter.join("practice", "Curator");

    const render = (state: RoundViewState = director.getState()): void => {
      act(() => {
        root.render(
          <LobbyHud
            state={state}
            roomCode=""
            onReady={() => undefined}
            onStart={() => undefined}
            onAddBot={() => actions.addBot()}
            onRemoveBot={() => actions.removeBot()}
          />,
        );
      });
    };

    render();
    expect(director.getState().botSeats.count).toBe(0);
    expect(rosterText()).toContain("Fill seats with bots");
    // Nothing to give up yet.
    expect(buttonLabelled("Remove a bot").disabled).toBe(true);

    act(() => {
      buttonLabelled("Add a bot").click();
    });
    render();
    act(() => {
      buttonLabelled("Add a bot").click();
    });
    render();

    const seated = director.getState();
    expect(seated.roster).toHaveLength(3);
    expect(seated.botSeats.count).toBe(2);
    expect(seated.roster.filter((player) => player.isBot).map((player) => player.seatId)).toEqual(
      adapter.bots.botSeatIds(),
    );
    for (const player of seated.roster.filter((entry) => entry.isBot)) {
      expect(isBotSeat(player.seatId)).toBe(true);
    }
    // The lobby names the machines rather than leaving three rows that read
    // like three people.
    expect(rosterText()).toContain("bot");
    expect(rosterText()).toContain("Curator");

    act(() => {
      buttonLabelled("Remove a bot").click();
    });
    render();
    expect(director.getState().roster).toHaveLength(2);
    expect(director.getState().botSeats.count).toBe(1);

    director.dispose();
    adapter.dispose();
  });

  it("offers the controls to the host alone", async () => {
    const adapter = new LocalLoopbackAdapter({ seed: 3 });
    const director = new RoundDirector(adapter, { tickIntervalMs: 0 });
    await adapter.join("practice", "Curator");

    // What a client that is not running the simulation sees: the seats exist
    // in the room, and the controls for them belong to whoever holds it.
    const asGuest: RoundViewState = {
      ...director.getState(),
      botSeats: { ...director.getState().botSeats, canManage: false },
    };
    act(() => {
      root.render(
        <LobbyHud
          state={asGuest}
          roomCode=""
          onReady={() => undefined}
          onStart={() => undefined}
          onAddBot={() => undefined}
          onRemoveBot={() => undefined}
        />,
      );
    });
    expect(rosterText()).not.toContain("Fill seats with bots");

    director.dispose();
    adapter.dispose();
  });
});
