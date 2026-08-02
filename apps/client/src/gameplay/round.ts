import type { NetworkAdapter } from "../networking/NetworkAdapter";
import type { RoundDirector } from "./RoundDirector";
import type { RoundSpatialBridge } from "./roundSpatial";

/**
 * What a round factory hands the shell, whatever transport is underneath it.
 *
 * `GameHost.enterRoundMode` takes exactly these three and nothing narrower, so
 * the loopback round and the Portals round are interchangeable from the shell's
 * point of view: the same RoundDirector reads the same NetworkAdapter interface
 * and the same RoundSession fills in the same geometry bridge.
 */
export interface GameRound {
  readonly adapter: NetworkAdapter;
  readonly director: RoundDirector;
  readonly spatial: RoundSpatialBridge;
  dispose(): void;
}

/**
 * Roles come off a shuffle seeded with the simulation's seed and the round
 * number, so a fixed seed would hand the same seat the same role in the first
 * round of every session. A round therefore draws its own seed unless a caller
 * asks for a particular deal.
 */
export function dealSeed(): number {
  return (Math.random() * 0x7fffffff) >>> 0;
}
