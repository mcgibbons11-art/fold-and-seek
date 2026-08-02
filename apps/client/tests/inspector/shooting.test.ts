import { CORRECT_ACCUSATION_COOLDOWN_MS, type MatchCommand } from "@foldseek/game-sim";
import { describe, expect, it } from "vitest";

import type { FocusMetadata } from "../../src/inspector/FocusSystem";
import {
  DEFAULT_FIRE_COOLDOWN_MS,
  ShootingDriver,
  type ShotOutcome,
} from "../../src/inspector/ShootingDriver";
import { testSettings } from "./navFixture";

const FRAME_MS = 50;
const COOLDOWN_FRAMES = Math.ceil(DEFAULT_FIRE_COOLDOWN_MS / FRAME_MS);

function focusOn(objectId: string, overrides: Partial<FocusMetadata> = {}): FocusMetadata {
  return {
    objectId,
    categoryId: "lamp",
    phase: "hover",
    // Comfortably inside the gun's reach, whatever that is tuned to.
    distanceM: testSettings().accusationDistance / 2,
    holdMs: 0,
    visible: true,
    accusable: true,
    ...overrides,
  };
}

interface Harness {
  readonly driver: ShootingDriver;
  readonly commands: MatchCommand[];
  readonly shots: { outcome: ShotOutcome; targetObjectId: string | null }[];
  /** One frame with the trigger pressed. */
  fire(focus: FocusMetadata | null): void;
  /** Frames with the trigger released, to run a cooldown down. */
  wait(frames: number, focus?: FocusMetadata | null): void;
}

function harness(ammo = 5): Harness {
  const commands: MatchCommand[] = [];
  const shots: { outcome: ShotOutcome; targetObjectId: string | null }[] = [];
  const driver = new ShootingDriver({
    settings: testSettings(),
    sendCommand: (command) => commands.push(command),
    onShot: (outcome, targetObjectId) => shots.push({ outcome, targetObjectId }),
  });
  driver.setAmmo(ammo);
  return {
    driver,
    commands,
    shots,
    fire(focus) {
      driver.update(FRAME_MS, focus, true, false);
    },
    wait(frames, focus = null) {
      for (let i = 0; i < frames; i += 1) driver.update(FRAME_MS, focus, false, false);
    },
  };
}

describe("ShootingDriver firing", () => {
  it("turns a hit on an inspectable object into the accuse command", () => {
    const h = harness();
    h.fire(focusOn("prop-lamp"));

    expect(h.commands).toEqual([{ type: "accuse", targetObjectId: "prop-lamp" }]);
    expect(h.shots).toEqual([{ outcome: "hit", targetObjectId: "prop-lamp" }]);
    expect(h.driver.phase).toBe("pending");
  });

  it("fires once per click, not once per frame the button is down", () => {
    const h = harness();
    h.driver.update(FRAME_MS, focusOn("prop-lamp"), true, false);
    for (let i = 0; i < 20; i += 1) {
      h.driver.update(FRAME_MS, focusOn("prop-lamp"), false, false);
    }
    expect(h.commands).toHaveLength(1);
  });

  it("counts a round that hits nothing as a dry miss costing no warrant", () => {
    const h = harness();
    h.fire(null);

    expect(h.commands).toHaveLength(0);
    expect(h.shots).toEqual([{ outcome: "miss", targetObjectId: null }]);
    expect(h.driver.state.ammo).toBe(5);
    expect(h.driver.phase).toBe("cooling");
  });

  it("counts a round at a target the geometry covers as a dry miss", () => {
    const h = harness();
    h.fire(focusOn("prop-lamp", { visible: false, accusable: false }));

    expect(h.commands).toHaveLength(0);
    expect(h.shots[0]?.outcome).toBe("miss");
  });

  it("counts a hit beyond the effective range as a dry miss", () => {
    const settings = testSettings();
    const h = harness();
    h.fire(
      focusOn("prop-lamp", {
        distanceM: settings.accusationDistance + 0.5,
        accusable: false,
      }),
    );

    expect(h.commands).toHaveLength(0);
    expect(h.shots).toEqual([{ outcome: "out_of_range", targetObjectId: null }]);
    expect(h.driver.state.ammo).toBe(5);
  });

  it("refuses to spend a round on an object the map does not allow accusing", () => {
    const h = harness();
    h.fire(focusOn("architecture-beam", { accusable: false }));

    expect(h.commands).toHaveLength(0);
    expect(h.shots[0]?.outcome).toBe("not_shootable");
  });

  it("clicks empty when the warrants are gone", () => {
    const h = harness(0);
    h.fire(focusOn("prop-lamp"));

    expect(h.commands).toHaveLength(0);
    expect(h.shots[0]?.outcome).toBe("empty");
    expect(h.driver.phase).toBe("cooling");
  });

  it("reports the reticle state the trigger would act on", () => {
    const settings = testSettings();
    const h = harness();

    h.driver.update(FRAME_MS, null, false, false);
    expect(h.driver.state.target).toBe("none");

    h.driver.update(FRAME_MS, focusOn("prop-lamp"), false, false);
    expect(h.driver.state.target).toBe("in_range");

    h.driver.update(
      FRAME_MS,
      focusOn("prop-lamp", { distanceM: settings.accusationDistance + 1, accusable: false }),
      false,
      false,
    );
    expect(h.driver.state.target).toBe("out_of_range");

    h.driver.update(FRAME_MS, focusOn("beam", { accusable: false }), false, false);
    expect(h.driver.state.target).toBe("not_shootable");
  });

  it("publishes the aim flag for the viewmodel", () => {
    const h = harness();
    h.driver.update(FRAME_MS, null, false, true);
    expect(h.driver.state.aiming).toBe(true);

    h.driver.update(FRAME_MS, null, false, false);
    expect(h.driver.state.aiming).toBe(false);
  });
});

describe("ShootingDriver cooldown", () => {
  it("holds the trigger for the fire cooldown even after a dry miss", () => {
    const h = harness();
    h.fire(null);
    expect(h.driver.cooldownRemainingMs).toBe(DEFAULT_FIRE_COOLDOWN_MS);

    h.wait(Math.floor(COOLDOWN_FRAMES / 2));
    h.fire(focusOn("prop-lamp"));
    expect(h.commands).toHaveLength(0);
    expect(h.driver.phase).toBe("cooling");

    h.wait(COOLDOWN_FRAMES);
    expect(h.driver.phase).toBe("ready");
    h.fire(focusOn("prop-lamp"));
    expect(h.commands).toHaveLength(1);
    expect(h.driver.state.shotsFired).toBe(2);
  });

  it("does not extend the lockout when the player spams the trigger", () => {
    const h = harness();
    h.fire(null);
    const afterFirstShot = h.driver.cooldownRemainingMs;

    for (let i = 0; i < 5; i += 1) h.fire(focusOn("prop-lamp"));
    expect(h.driver.cooldownRemainingMs).toBeLessThan(afterFirstShot);
    expect(h.driver.state.shotsFired).toBe(1);
  });

  it("blocks a second shot while the authority has not answered the first", () => {
    const h = harness();
    h.fire(focusOn("prop-lamp"));
    h.wait(COOLDOWN_FRAMES * 3, focusOn("prop-lamp"));
    h.fire(focusOn("prop-lamp"));

    expect(h.commands).toHaveLength(1);
    expect(h.driver.phase).toBe("pending");
  });

  it("holds the wrong-accusation cooldown from the settings after a wrong hit", () => {
    const settings = testSettings();
    const h = harness();
    h.fire(focusOn("prop-lamp"));
    h.driver.handleResolved(false);

    expect(h.driver.phase).toBe("cooling");
    expect(h.driver.cooldownRemainingMs).toBe(settings.wrongAccusationCooldownMs);

    const frames = Math.ceil(settings.wrongAccusationCooldownMs / FRAME_MS);
    h.wait(Math.floor(frames / 2));
    h.fire(focusOn("prop-lamp"));
    expect(h.commands).toHaveLength(1);
    expect(h.driver.phase).toBe("cooling");

    h.wait(frames);
    h.fire(focusOn("prop-lamp"));
    expect(h.commands).toHaveLength(2);
  });

  it("overlaps the trigger delay with the accusation penalty instead of stacking", () => {
    const h = harness();
    h.fire(focusOn("prop-lamp"));
    h.driver.handleResolved(true);

    expect(h.driver.cooldownRemainingMs).toBe(DEFAULT_FIRE_COOLDOWN_MS);
    expect(CORRECT_ACCUSATION_COOLDOWN_MS).toBeLessThan(DEFAULT_FIRE_COOLDOWN_MS);
  });

  it("adopts the authority's cooldown when the shot is refused for one", () => {
    const h = harness();
    h.fire(focusOn("prop-lamp"));
    h.driver.handleRejection("accusation_cooldown");

    expect(h.driver.phase).toBe("cooling");
    expect(h.driver.cooldownRemainingMs).toBe(testSettings().wrongAccusationCooldownMs);
  });

  it("frees the trigger when the refusal was not a cooldown", () => {
    const h = harness();
    h.fire(focusOn("prop-lamp"));
    h.driver.handleRejection("no_warrants");

    expect(h.driver.phase).toBe("cooling");
    h.wait(COOLDOWN_FRAMES);
    expect(h.driver.phase).toBe("ready");
  });

  it("ignores a resolution that does not belong to a shot of its own", () => {
    const h = harness();
    h.driver.handleResolved(false);

    expect(h.driver.phase).toBe("ready");
    expect(h.driver.cooldownRemainingMs).toBe(0);
  });

  it("releases the trigger if the authority never answers", () => {
    const h = harness();
    h.fire(focusOn("prop-lamp"));
    h.wait(Math.ceil(5000 / FRAME_MS) + 1);

    expect(h.driver.phase).toBe("ready");
    expect(h.commands).toHaveLength(1);
  });

  it("clears everything when the round phase takes control away", () => {
    const h = harness();
    h.fire(focusOn("prop-lamp"));
    h.driver.cancel();

    expect(h.driver.phase).toBe("ready");
    expect(h.driver.cooldownRemainingMs).toBe(0);
  });

  it("tracks warrants as ammunition", () => {
    const h = harness(3);
    expect(h.driver.state.ammo).toBe(3);

    h.driver.setAmmo(2);
    expect(h.driver.state.ammo).toBe(2);
  });
});
