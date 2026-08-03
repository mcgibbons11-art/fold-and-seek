// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function press(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
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
    const custom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Custom room and training",
    );
    if (custom === undefined) throw new Error("custom options control is missing");
    click(custom);
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

    const request = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Request to join",
    );
    if (request === undefined) throw new Error("selected-room request control is missing");
    click(request);
    advance();

    expect(reader.getRoomCode()).toBeNull();
    expect(reader.outgoingJoinRequest()?.roomCode).toBe(opened.code);
    expect(host.pendingJoinRequests().map((request) => request.displayName)).toEqual(["Bex"]);

    render(reader, () => undefined);
    const pending = rows()[0];
    if (pending === undefined) throw new Error("the room should still have a row");
    expect(pending.textContent).toContain("Pending");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Request to join")).toBe(false);
  });

  it("offers semantic room options with roving arrow, Enter, and Space selection", async () => {
    const firstHost = await browsingClient("a", "Ada");
    const secondHost = await browsingClient("b", "Bex");
    const reader = await browsingClient("c", "Cal");
    expect(firstHost.createRoom("Amber Room").ok).toBe(true);
    expect(secondHost.createRoom("Blue Room").ok).toBe(true);
    advance();
    render(reader, () => undefined);

    const listbox = container.querySelector('[role="listbox"]');
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(listbox?.getAttribute("aria-label")).toBe("Available rooms");
    expect(options).toHaveLength(2);

    options[0]?.focus();
    press(options[0] as HTMLButtonElement, "ArrowDown");
    expect(document.activeElement).toBe(options[1]);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    press(options[0] as HTMLButtonElement, "Enter");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    press(options[1] as HTMLButtonElement, " ");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("lets the host retire their advertised room without leaving matchmaking", async () => {
    const host = await browsingClient("a", "Ada");
    const opened = host.createRoom("The Attic");
    if (!opened.ok) throw new Error(opened.reason);
    advance();
    let cancellations = 0;
    act(() => {
      root.render(
        <RoomBrowser
          rooms={host.listRooms()}
          currentCode={host.getRoomCode()}
          onJoin={() => undefined}
          onCreate={() => undefined}
          onQuickJoin={() => undefined}
          onCancelHostedRoom={() => {
            cancellations += 1;
            host.leaveRoom();
          }}
        />,
      );
    });

    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel hosted room",
    );
    if (cancel === undefined) throw new Error("host cancellation control is missing");
    click(cancel);
    advance();

    expect(cancellations).toBe(1);
    expect(host.getRoomCode()).toBeNull();
    expect(host.listRooms()).toHaveLength(0);
  });

  it("selects a newly hosted room so cancellation cannot hide behind an older listing", async () => {
    const other = await browsingClient("a", "Ada");
    const host = await browsingClient("b", "Bex");
    const first = other.createRoom("Older room");
    if (!first.ok) throw new Error(first.reason);
    advance();
    render(host, () => undefined);

    const opened = host.createRoom("Fresh room");
    if (!opened.ok) throw new Error(opened.reason);
    advance();
    act(() => {
      root.render(
        <RoomBrowser
          rooms={host.listRooms()}
          currentCode={host.getRoomCode()}
          onJoin={() => undefined}
          onCreate={() => undefined}
          onQuickJoin={() => undefined}
          onCancelHostedRoom={() => undefined}
        />,
      );
    });

    expect(container.querySelector('[aria-label="Selected room"]')?.textContent).toContain(
      "Fresh room",
    );
    expect(container.textContent).toContain("Cancel hosted room");
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
    expect(packedRow.textContent).toContain("Full");
    const packedOption = packedRow.querySelector<HTMLButtonElement>('[role="option"]');
    if (packedOption === null) throw new Error("the full room should remain selectable");
    press(packedOption, " ");
    expect(packedOption.getAttribute("aria-selected")).toBe("true");
    const join = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Room full",
    );
    expect(join?.disabled).toBe(true);
    expect(container.textContent).toContain(`${MAX_CONCURRENT_ROOMS} of ${MAX_CONCURRENT_ROOMS}`);
    expect(container.textContent).toContain(`holds ${MAX_CONCURRENT_ROOMS} rooms at once`);

    const custom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Custom room and training",
    );
    if (custom !== undefined) click(custom);
    const newRoom = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "New room",
    );
    expect(newRoom?.disabled).toBe(true);
  });

  it("keeps selected-room and host request controls reachable in the narrow composition", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 660 });
    const host = await browsingClient("a", "Ada");
    const guest = await browsingClient("b", "Bex");
    const opened = host.createRoom("Narrow Room");
    if (!opened.ok) throw new Error(opened.reason);
    advance();
    expect(guest.requestRoom(opened.code).ok).toBe(true);
    advance();

    act(() => {
      root.render(
        <RoomBrowser
          rooms={host.listRooms()}
          currentCode={opened.code}
          pendingRequests={host.pendingJoinRequests()}
          onJoin={() => undefined}
          onCreate={() => undefined}
          onQuickJoin={() => undefined}
          onAcceptRequest={() => undefined}
          onDeclineRequest={() => undefined}
          onCancelHostedRoom={() => undefined}
        />,
      );
    });

    const screen = container.querySelector<HTMLElement>(".fs-matchmaking-screen");
    const columns = container.querySelector<HTMLElement>(".fs-matchmaking-columns");
    expect(screen?.style.inset).toBe("0px");
    expect(columns?.style.overflow).toBe("hidden");
    expect(container.querySelector('[aria-label="Selected room"]')?.textContent).toContain("Narrow Room");
    expect(container.querySelector('[aria-label="Pending join request"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(
      expect.arrayContaining(["Accept", "Decline", "Cancel hosted room"]),
    );
  });

  it("runs one recovery action, categorizes it, and returns focus after dismissal", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const retry = vi.fn();
    const reconnect = vi.fn();
    const dismiss = vi.fn();
    const host = await browsingClient("a", "Ada");
    const reader = await browsingClient("b", "Bex");
    expect(host.createRoom("Focus Room").ok).toBe(true);
    advance();
    act(() => {
      root.render(
        <RoomBrowser
          rooms={reader.listRooms()}
          notice="That room has closed. Pick another."
          onJoin={() => undefined}
          onCreate={() => undefined}
          onQuickJoin={() => undefined}
          onRetryNotice={retry}
          onReconnect={reconnect}
          onDismissNotice={dismiss}
        />,
      );
    });

    const alert = container.querySelector('[aria-label="Room error"]');
    expect(alert?.textContent).toContain("Retry");
    const retryButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    if (retryButton === undefined) throw new Error("retry control is missing");
    click(retryButton);
    click(retryButton);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <RoomBrowser
          rooms={reader.listRooms()}
          notice="The room listing could not be shared. Reconnect to the session."
          onJoin={() => undefined}
          onCreate={() => undefined}
          onQuickJoin={() => undefined}
          onRetryNotice={retry}
          onReconnect={reconnect}
          onDismissNotice={dismiss}
        />,
      );
    });
    expect(container.querySelector('[aria-label="Network error"]')?.textContent).toContain("Reconnect");
    const reconnectButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reconnect",
    );
    if (reconnectButton === undefined) throw new Error("reconnect control is missing");
    click(reconnectButton);
    click(reconnectButton);
    expect(reconnect).toHaveBeenCalledTimes(1);
    const dismissButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Dismiss",
    );
    if (dismissButton === undefined) throw new Error("dismiss control is missing");
    click(dismissButton);
    click(dismissButton);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Network error"]')).toBeNull();
    expect((document.activeElement as HTMLElement | null)?.dataset.roomCode).toBeDefined();
    vi.unstubAllGlobals();
  });
});
