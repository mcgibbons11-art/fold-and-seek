import type { MatchSettingsPatch } from "@foldseek/game-sim";

import { PortalsNetAdapter } from "../networking/PortalsNetAdapter";
import type { PortalsSdk } from "../types/portals";
import { buildObjectRegistry } from "../world/maps/registry";
import { createBotPlay } from "./botPlay";
import { dealSeed, type GameRound } from "./round";
import { RoundDirector } from "./RoundDirector";
import { RoundSpatialBridge } from "./roundSpatial";

/**
 * A round played with the other people in a Portals room (§4.3, architecture
 * decision 1). It is the loopback round's sibling and deliberately assembles
 * the same three pieces: the authoritative simulation runs somewhere, a
 * RoundDirector folds what it reports into one view state, and a spatial bridge
 * tells it where things are in the shop.
 *
 * What differs is only where the simulation runs. `PortalsNetAdapter` elects
 * one client to hold it and relays commands to that client, so on the elected
 * host the registry and the validator below drive a real simulation, and on
 * every other client they sit idle until a host migration hands that client the
 * round. They are passed on every client for exactly that reason: whoever is
 * promoted has to already be holding the map the departed host was running.
 */

/**
 * The relay's default session bucket. A Portals room already is the session, so
 * naming a channel inside it would split the people in one room into sub-lobbies
 * that cannot see each other. The adapter reads an empty room as "no channel".
 */
export const PORTALS_ROUND_CHANNEL = "";

export interface PortalsRound extends GameRound {
  readonly adapter: PortalsNetAdapter;
}

export interface PortalsRoundOptions {
  /** The injected SDK, as `detectPortalsSession` found it. */
  readonly sdk: PortalsSdk;
  /** Fixed seed for a repeatable deal. Omitted, every round deals afresh. */
  readonly seed?: number;
  /** Shortened phase durations, for driving a whole round headlessly. */
  readonly settings?: MatchSettingsPatch;
  /** Clock source. Defaults to the adapter's, which is Date.now(). */
  readonly now?: () => number;
}

export function createPortalsRound(options: PortalsRoundOptions): PortalsRound {
  const spatial = new RoundSpatialBridge();
  const seed = options.seed ?? dealSeed();
  const adapter = new PortalsNetAdapter(options.sdk, {
    seed,
    spatial: spatial.validator,
    objectRegistry: buildObjectRegistry(),
    // Bots the host seats play the round through the same brain practice uses.
    // Like the registry and the validator, they are passed on every client,
    // because whoever is promoted has to be able to go on driving them.
    ...createBotPlay(spatial, seed),
    // The host's half of the eye channel: what a remote Inspector reports goes
    // into the same validator its own accusations are then checked against.
    onInspectorEye: (seatId, eye) => {
      spatial.acceptInspectorEye(seatId, eye === null ? null : { x: eye[0], y: eye[1], z: eye[2] });
    },
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  // The client's half. The round writes its own camera into the bridge every
  // frame whatever the transport, and on this one the authority is usually
  // somewhere else, so that write has to travel. Only this client's own eye is
  // ever forwarded: a host applying a remote report must not relay it onward.
  spatial.observeInspectorEye((inspectorId, eye) => {
    if (inspectorId !== adapter.getSelfId()) return;
    adapter.reportInspectorEye(eye === null ? null : [eye.x, eye.y, eye.z]);
  });

  const director = new RoundDirector(adapter);

  return {
    adapter,
    director,
    spatial,
    dispose() {
      director.dispose();
      adapter.dispose();
    },
  };
}
