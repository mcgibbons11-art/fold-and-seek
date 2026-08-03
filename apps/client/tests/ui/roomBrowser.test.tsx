// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PortalsNetAdapter } from "../../src/networking/PortalsNetAdapter";
import { MAX_CONCURRENT_ROOMS } from "../../src/networking/roomRegistry";
import { RoomBrowser } from "../../src/ui/RoomBrowser";
import { FakePortalsRelay } from "../networking/fakePortals";

/**
 * The room browser, driven through real adapters over the fake relay rather
 * than a hand-written list. What is worth proving is the whole chain: one
 * client opens a room, the advertisement crosses the session, the panel draws
 * a row for it, and pressing the row's button asks the host before the reader
 * is seated in that room.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const CHANNEL = "fold-seek-browser";

let container: HTMLDivElement;
let root: Root;
let clock = 1_700_000_000_000;
let relay: FakePortalsRelay;
const adapters: PortalsNetAdapter[] = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  clock = 1_700_000_000_000;
  relay = new FakePortalsRelay();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  for (const adapter of adapters) adapter.dispose();
  adapters.length = 0;
});

async function browsingClient(id: string, displayName: string): Promise<PortalsNetAdapter> {
  const adapter = new PortalsNetAdapter(relay.createPeer({ id, displayName }), {
    seed: 5,
    now: () => clock,
    joinRetryDelayMs: 0,
  });
  adapters.push(adapter);
  await adapter.connect();
  await adapter.joinSession(CHANNEL, displayName);
  return adapter;
}

/** Lets every client publish, the way the flush and tick timers would. */
function advance(steps = 3): void {
  for (let index = 0; index < steps; index += 1) {
    clock += 100;
    for (const adapter of adapters) adapter.tick();
  }
}

function render(adapter: PortalsNetAdapter, onJoin: (code: string) => void): void {
  act(() => {
    root.render(
      <RoomBrowser
        rooms={adapter.listRooms()}
        currentCode={adapter.getRoomCode()}
        pendingRequests={adapter.pendingJoinRequests()}
        outgoingRequest={adapter.outgoingJoinRequest()}
        onJoin={onJoin}
        onCreate={() => undefined}
        onQuickJoin={() => undefined}
      />,
    );
  });
}

function rows(): HTMLLIElement[] {
  return [...container.querySelectorAll("li")];
}

function buttonIn(row: HTMLElement): HTMLButtonElement {
  const found = row.querySelector("button");
  if (found === null) throw new Error("row has no button");
  return found;
}

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the room browser", () => {
  it("says so when nobody has opened a room", async () => {
    const reader = await browsingClient("b", "Bex");
    render(reader, () => undefined);

    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("Nobody has opened a room yet");
    expect(container.textContent).toContain(`0 of ${MAX_CONCURRENT_ROOMS}`);
  });

  it("shows room failures beside the room controls", async () => {
    const reader = await browsingClient("b", "Bex");
    act(() => {
      root.render(
        <RoomBrowser
          rooms={reader.listRooms()}
          onJoin={() => undefined}
          onCreate={() => undefined}
          onQuickJoin={() => undefined}
          notice="The room could not be advertised."
        />,
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be advertised",
    );
  });

  it("returns to the main menu from both the lobby button and Escape", async () => {
    const reader = await browsingClient("b", "Bex");
    let backs = 0;
    act(() => {
      root.render(
        <RoomBrowser
          rooms={reader.listRooms()}
          onJoin={() => undefined}
          onCreate={() => undefined}
          onQuickJoin={() => undefined}
          onBack={() => {
            backs += 1;
          }}
        />,
      );
    });

    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Return to main menu",
    );
    if (back === undefined) throw new Error("main-menu control is missing");
    click(back);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(backs).toBe(2);
  });

  it("opens a room without a native form submission that Portals sandboxes block", async () => {
    const reader = await browsingClient("b", "Bex");
    let creates = 0;
    act(() => {
      root.render(
        <RoomBrowser
          rooms={reader.listRooms()}
          onJoin={() => undefined}
          onCreate={() => {
            creates += 1;
          }}
          onQuickJoin={() => undefined}
        />,
      );
    });

    expect(container.querySelector("form")).toBeNull();
    const newRoom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "New room",
    );
    if (newRoom === undefined) throw new Error("new-room control is missing");
    click(newRoom);
    expect(creates).toBe(1);

    const input = container.querySelector<HTMLInputElement>('[aria-label="Room name"]');
    if (input === null) throw new Error("room-name control is missing");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(creates).toBe(2);
  });

  it("draws another client's room and requests host approval from its row", async () => {
    const host = await browsingClient("a", "Ada");
    const reader = await browsingClient("b", "Bex");
    const opened = host.createRoom("The Attic");
    if (!opened.ok) throw new Error(opened.reason);
    advance();

    render(reader, (code) => {
      reader.requestRoom(code);
    });

    const row = rows()[0];
    if (row === undefined) throw new Error("the room should have a row");
    expect(row.textContent).toContain("The Attic");
    expect(row.textContent).toContain(opened.code);
    expect(row.textContent).toContain("Waiting");
    // One seat taken of the twelve the first room's key ranges can carry.
    expect(row.textContent).toContain("1/12");

    click(buttonIn(row));
    advance();

    expect(reader.getRoomCode()).toBeNull();
    expect(reader.outgoingJoinRequest()?.roomCode).toBe(opened.code);
    expect(host.pendingJoinRequests().map((request) => request.displayName)).toEqual(["Bex"]);

    render(reader, () => undefined);
    const pending = rows()[0];
    if (pending === undefined) throw new Error("the room should still have a row");
    expect(buttonIn(pending).textContent).toBe("Pending");
    expect(buttonIn(pending).disabled).toBe(true);
  });

  it("refuses a full room and says the session is out of slots", async () => {
    const first = await browsingClient("a", "Ada");
    const second = await browsingClient("b", "Bex");
    const reader = await browsingClient("c", "Cal");

    // Two seats is the smallest room the settings allow, so one more arrival
    // fills it and the row has to say so rather than offer a join that fails.
    const full = new PortalsNetAdapter(relay.createPeer({ id: "d", displayName: "Dot" }), {
      seed: 5,
      now: () => clock,
      joinRetryDelayMs: 0,
      settings: { maxPlayers: 2 },
    });
    adapters.push(full);
    await full.connect();
    await full.joinSession(CHANNEL, "Dot");
    const packed = full.createRoom("Two Seats");
    if (!packed.ok) throw new Error(packed.reason);
    advance();
    expect(first.enterRoom(packed.code).ok).toBe(true);
    advance();

    // The session's other slot goes to a second room, which is what makes the
    // panel report the session full as well as the room.
    expect(second.createRoom("The Cellar").ok).toBe(true);
    advance();

    render(reader, () => undefined);
    const packedRow = rows().find((row) => row.textContent?.includes("Two Seats"));
    if (packedRow === undefined) throw new Error("the full room should still be listed");
    expect(buttonIn(packedRow).textContent).toBe("Full");
    expect(buttonIn(packedRow).disabled).toBe(true);
    expect(container.textContent).toContain(`${MAX_CONCURRENT_ROOMS} of ${MAX_CONCURRENT_ROOMS}`);
    expect(container.textContent).toContain(`holds ${MAX_CONCURRENT_ROOMS} rooms at once`);

    const newRoom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "New room",
    );
    expect(newRoom?.disabled).toBe(true);
  });
});
