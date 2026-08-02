import { WORLD_SCALE } from "../inspector/navData";

/**
 * How much quieter a sound is for happening somewhere else in the shop.
 *
 * Every one-shot played flat until now, so a clock chiming at the far wall and
 * one chiming at the player's feet arrived at the same volume and the shop had
 * no depth to it. Two events are worth placing: an innocent object answering a
 * warrant, and a hider taunting from wherever it is hiding.
 *
 * Quoted against `WORLD_SCALE.playerHeight` like every other distance in the
 * game, so the giant scale (override 4) moves this with one knob rather than
 * leaving the falloff tuned for a human in a room the player is not.
 */

/** Inside this, a sound is simply here. About two body lengths. */
const REFERENCE_DISTANCE_M = WORLD_SCALE.playerHeight * 2;

/** How hard it falls away past the reference. 1 is inverse-distance. */
const ROLLOFF = 0.55;

/**
 * Nothing is ever attenuated past this.
 *
 * A reaction is not only atmosphere: it is how an Inspector learns which object
 * they just spent a warrant on, and the warrant range reaches most of the way
 * across the sales floor. A realistic falloff would make a shot at maximum range
 * report almost silently, which would take the answer away from the one player
 * who most needs it. Depth is worth having; the information is worth more.
 */
const MINIMUM_GAIN = 0.3;

/**
 * Gain for a source `distanceM` away from the listener. 1 when it is on top of
 * the listener, never below `MINIMUM_GAIN` however far off it is.
 */
export function distanceGain(distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM <= REFERENCE_DISTANCE_M) return 1;
  const beyond = distanceM - REFERENCE_DISTANCE_M;
  const gain = REFERENCE_DISTANCE_M / (REFERENCE_DISTANCE_M + ROLLOFF * beyond);
  return Math.max(MINIMUM_GAIN, gain);
}
