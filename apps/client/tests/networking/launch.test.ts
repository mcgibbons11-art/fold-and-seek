import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortalsNetAdapter } from "../../src/networking/PortalsNetAdapter";
import { roomChannelName } from "../../src/networking/roomRegistry";
import { FakePortalsRelay } from "./fakePortals";

/**
 * Moving a room into a channel of its own.
 *
 * There is one lobby: a player who is accepted lands in it beside everyone
 * else, and the host answers waiting requests from that same screen. The move
 * below is what carries the whole room onto its own channel, where Portals
 * runs a server script for that match alone and gives it the session's whole
 * state-key budget.
 *
 * The transport is tested here rather than the screen: the party travels
 * together, only the room's host can send it anywhere, and a guest that was
 * accepted is carried along even though it holds no room of its own yet.
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

  it("keeps delivering join requests to a host that is inside its room", async () => {
    const host = peer(relay, "a");
    await host.connect();
    // joinSession leaves this client browsing; join() would quick-join or
    // create a room for it, which is not the state a host opens a room from.
    await host.joinSession(CHANNEL, "Ada");
    const created = host.createRoom("The Attic");
    expect(created.ok).toBe(true);
    await elapse(200);

    const pending: string[][] = [];
    host.onRoomRequests((requests) => pending.push(requests.map((r) => r.id)));

    const first = peer(relay, "b");
    await first.connect();
    await first.joinSession(CHANNEL, "Bex");
    first.requestRoom(host.getRoomCode() ?? "");
    await elapse(200);
    expect(pending.at(-1)).toContain("b");

    const accepted = host.acceptRoomRequest("b");
    expect(accepted.ok).toBe(true);
    await elapse(200);

    // The transport always delivered these, whether or not the host had
    // entered its room; what broke a filling party was the host being moved
    // to a screen that did not show them. One lobby, so it now does.
    const second = peer(relay, "c");
    await second.connect();
    await second.joinSession(CHANNEL, "Cass");
    second.requestRoom(host.getRoomCode() ?? "");
    await elapse(200);

    expect(pending.at(-1)).toContain("c");
    expect(host.acceptRoomRequest("c").ok).toBe(true);

    host.dispose();
    first.dispose();
    second.dispose();
  });

  it("leaves a simultaneous second request standing when the first is accepted", async () => {
    const host = peer(relay, "a");
    await host.connect();
    await host.joinSession(CHANNEL, "Ada");
    host.createRoom("The Attic");
    await elapse(200);

    const pending: string[][] = [];
    host.onRoomRequests((requests) => pending.push(requests.map((r) => r.id)));

    // Two players ask in the same breath, which is the ordinary case when a
    // room is advertised and several people are watching the browser.
    const first = peer(relay, "b");
    const second = peer(relay, "c");
    await first.connect();
    await second.connect();
    await first.joinSession(CHANNEL, "Bex");
    await second.joinSession(CHANNEL, "Cass");
    const code = host.getRoomCode() ?? "";
    first.requestRoom(code);
    second.requestRoom(code);
    await elapse(200);
    expect(pending.at(-1)).toEqual(expect.arrayContaining(["b", "c"]));

    const declined: string[] = [];
    second.onRoomDecision((decision) => {
      if (!decision.accepted) declined.push(decision.reason);
    });

    expect(host.acceptRoomRequest("b").ok).toBe(true);
    await elapse(200);

    // Accepting one used to decline the rest, so the second player was told
    // no and had to notice and ask again.
    expect(declined).toEqual([]);
    expect(pending.at(-1)).toContain("c");
    expect(host.acceptRoomRequest("c").ok).toBe(true);

    host.dispose();
    first.dispose();
    second.dispose();
  });

  it("carries an accepted guest in, though it never entered the room", async () => {
    const host = peer(relay, "a");
    await host.connect();
    await host.joinSession(CHANNEL, "Ada");
    host.createRoom("The Attic");
    await elapse(200);

    const guest = peer(relay, "b");
    await guest.connect();
    await guest.joinSession(CHANNEL, "Bex");
    guest.requestRoom(host.getRoomCode() ?? "");
    await elapse(200);
    expect(host.acceptRoomRequest("b").ok).toBe(true);
    await elapse(200);

    // Accepted, and deliberately still outside the room: it holds no room
    // code, so a launch has to be matched against what it WAS accepted into
    // or it would simply be left behind in the lobby.
    expect(guest.getRoomCode()).toBeNull();

    const guestJoins = relay.joinAttempts.get("b") ?? 0;
    expect(host.launchRoom()).toMatchObject({ ok: true });
    await elapse(500);

    expect(relay.joinAttempts.get("b") ?? 0).toBeGreaterThan(guestJoins);

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
