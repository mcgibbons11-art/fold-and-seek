import { describe, expect, it } from "vitest";

import { distanceGain } from "../../src/audio/distance";
import { WORLD_SCALE } from "../../src/inspector/navData";

/**
 * The falloff that gives the shop depth. Every one-shot played flat before
 * this, so an object reacting at the far wall arrived as loudly as one at the
 * player's feet.
 *
 * What these pin down is the shape rather than the numbers: closer is never
 * quieter, distance never silences anything, and the curve is quoted against
 * the body rather than the metre so the giant scale moves it.
 */

const BODY = WORLD_SCALE.playerHeight;

describe("distance attenuation", () => {
  it("leaves a sound at the listener alone", () => {
    expect(distanceGain(0)).toBe(1);
  });

  it("does not attenuate inside the reference distance", () => {
    expect(distanceGain(BODY)).toBe(1);
  });

  it("gets quieter with distance, and never louder", () => {
    const steps = [0, 1, 2, 4, 8, 16, 32].map((n) => distanceGain(n * BODY));
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i] as number).toBeLessThanOrEqual(steps[i - 1] as number);
    }
    // Across the sales floor is audibly further off than underfoot.
    expect(distanceGain(20 * BODY)).toBeLessThan(distanceGain(3 * BODY));
  });

  it("never silences an event, however far away it happens", () => {
    // A reaction is how an Inspector learns which object they spent a warrant
    // on, and the warrant reaches most of the way across the shop. Realistic
    // falloff would take that answer away from the player who needs it.
    const veryFar = distanceGain(500 * BODY);
    expect(veryFar).toBeGreaterThan(0.25);
    expect(veryFar).toBeLessThan(0.5);
  });

  it("stays a gain, never out of range", () => {
    for (const metres of [0, 0.01, 1, 10, 1_000]) {
      const gain = distanceGain(metres);
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });

  it("treats a distance it cannot measure as here rather than far", () => {
    // An object the map does not know has no position to be far from.
    expect(distanceGain(Number.NaN)).toBe(1);
    expect(distanceGain(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
