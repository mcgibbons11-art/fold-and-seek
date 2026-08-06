import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortalsNetAdapter } from "../../src/networking/PortalsNetAdapter";
import { roomChannelName } from "../../src/networking/roomRegistry";
import { FakePortalsRelay } from "./fakePortals";

/**
 * Moving a settled room into a channel of its own.
 *
 * Players gather in the shared pre-match room and nobody moves on being
 * admitted: a room that scattered its players the moment each was accepted
 * would never let a host see who turned up. The host decides when the room is
 * settled and presses the button, and everyone travels together.
 *
 * The destination is not cosmetic. Portals runs one server script per channel,
 * so a room with its own channel gets an authoritative referee for that match
 * alone, and the session's whole state-key budget with it.
 */

const CHANNEL = "launch-test";

let clock = 0;

function peer(relay: FakePortalsRelay, id: string): PortalsNetAdapter {
  return new PortalsNetAdapter(relay.createPeer({ id, displayName: `Visitor ${id}` }), {
    seed: 5,
    now: () => clock,
    joinRetryDelayMs: 0,
  });
}

async function elapse(ms: number): Promise<void> {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

describe("launching a room into its own channel", () => {
  let relay: FakePortalsRelay;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    relay = new FakePortalsRelay();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names a channel Portals will accept, from the code players read aloud", () => {
    // Room codes are made to be said out loud and often start with a digit,
    // while a channel name may not. The prefix carries that requirement.
    expect(roomChannelName("9T9K")).toBe("room:9T9K");
    expect(roomChannelName("ABCD")).toBe("room:ABCD");
    expect(roomChannelName("bad code!")).toBeNull();
  });

  it("keeps everyone in the pre-match room until the host presses the button", async () => {
    const host = peer(relay, "a");
    await host.connect();
    await host.join(CHANNEL, "Ada");
    const guest = peer(relay, "b");
    await guest.connect();
    await guest.join(CHANNEL, "Bex");
    await elapse(200);

    // Admitted, seated, and still exactly where they started: nothing about
    // being accepted moves a player anywhere.
    const joinsBefore = relay.joinAttempts.get("b") ?? 0;
    await elapse(2_000);
    expect(relay.joinAttempts.get("b") ?? 0).toBe(joinsBefore);

    host.dispose();
    guest.dispose();
  });

  it("refuses to launch a room from a client that is not its host", async () => {
    const host = peer(relay, "a");
    await host.connect();
    await host.join(CHANNEL, "Ada");
    const guest = peer(relay, "b");
    await guest.connect();
    await guest.join(CHANNEL, "Bex");
    await elapse(200);

    expect(guest.isAuthority()).toBe(false);
    expect(guest.launchRoom()).toEqual({ ok: false, reason: "not_host" });

    host.dispose();
    guest.dispose();
  });

  it("takes the whole party with it when the host presses", async () => {
    const host = peer(relay, "a");
    await host.connect();
    await host.join(CHANNEL, "Ada");
    const guest = peer(relay, "b");
    await guest.connect();
    await guest.join(CHANNEL, "Bex");
    await elapse(200);

    const hostJoins = relay.joinAttempts.get("a") ?? 0;
    const guestJoins = relay.joinAttempts.get("b") ?? 0;

    const result = host.launchRoom();
    expect(result).toMatchObject({ ok: true });
    await elapse(500);

    // The host announces before it leaves - a sender never receives its own
    // broadcast, so leaving first would take the announcement with it - and
    // both ends then re-join, which on a real relay is the room's own channel.
    expect(relay.joinAttempts.get("a") ?? 0).toBeGreaterThan(hostJoins);
    expect(relay.joinAttempts.get("b") ?? 0).toBeGreaterThan(guestJoins);

    host.dispose();
    guest.dispose();
  });

  it("ignores a launch from someone who is not the room's host", async () => {
    const host = peer(relay, "a");
    await host.connect();
    await host.join(CHANNEL, "Ada");
    const guest = peer(relay, "b");
    await guest.connect();
    await guest.join(CHANNEL, "Bex");
    await elapse(200);

    const before = relay.joinAttempts.get("b") ?? 0;
    // A launch moves everyone off the channel, so it is the one message a
    // stranger must never be able to send.
    relay.injectRaw("stranger", {
      v: 2,
      t: "launch",
      r: host.getRoomCode(),
      channel: "room:ELSEWHERE",
    });
    await elapse(500);

    expect(relay.joinAttempts.get("b") ?? 0).toBe(before);
    host.dispose();
    guest.dispose();
  });
});
