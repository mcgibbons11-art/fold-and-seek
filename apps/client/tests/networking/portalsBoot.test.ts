// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { detectPortalsSession } from "../../src/networking/portalsBoot";
import type { PortalsContext, PortalsSdk } from "../../src/types/portals";
import { FakePortalsRelay } from "./fakePortals";

/**
 * What the shell asks at boot, and the only question that decides whether this
 * page plays with other people or by itself.
 *
 * The hard requirement is the negative one: outside Portals there is no SDK,
 * the probe must not throw, must not hang, and must leave the game on exactly
 * the path it took before any of this existed. Everything Portals gives us is
 * optional; the offline round is not.
 */

function installSdk(sdk: unknown): void {
  (window as unknown as { Portals?: unknown }).Portals = sdk;
}

afterEach(() => {
  delete (window as unknown as { Portals?: unknown }).Portals;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** An SDK whose ready() answers with the given context. */
function sdkInContext(context: PortalsContext): PortalsSdk {
  const relay = new FakePortalsRelay();
  const peer = relay.createPeer({ id: "self", displayName: "Ada", playerId: "player-1" });
  return {
    ...peer,
    ready: async () => ({
      player: { playerId: "player-1", displayName: "Ada", avatarUrl: null },
      context,
    }),
  } as PortalsSdk;
}

describe("detecting a Portals session", () => {
  it("reports the room and the player when the host injected the SDK", async () => {
    installSdk(sdkInContext("room"));

    const boot = await detectPortalsSession();

    expect(boot?.context).toBe("room");
    expect(boot?.player.displayName).toBe("Ada");
  });

  it("reports a standalone game page as standalone", async () => {
    installSdk(sdkInContext("standalone"));

    expect((await detectPortalsSession())?.context).toBe("standalone");
  });

  it("finds nothing outside Portals, where the SDK file does not exist", async () => {
    // Nothing on the window, and `_portals/sdk.js` is not served here, so the
    // dynamic import rejects. This is the offline case and it must be quiet.
    expect(await detectPortalsSession()).toBeNull();
  });

  it("finds nothing when something else is using the name Portals", async () => {
    // A page-level global that is not the SDK must not be mistaken for one:
    // the adapter would then call net.join on an object that has no such thing.
    installSdk({ ready: "not a function", net: null });

    expect(await detectPortalsSession()).toBeNull();
  });

  it("plays offline rather than waiting forever when ready() never settles", async () => {
    vi.useFakeTimers();
    installSdk({ ready: () => new Promise(() => undefined), net: {} } as unknown as PortalsSdk);

    const pending = detectPortalsSession();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await pending).toBeNull();
  });

  it("plays offline when ready() rejects", async () => {
    installSdk({
      ready: async () => {
        throw new Error("no host");
      },
      net: {},
    } as unknown as PortalsSdk);

    expect(await detectPortalsSession()).toBeNull();
  });
});
