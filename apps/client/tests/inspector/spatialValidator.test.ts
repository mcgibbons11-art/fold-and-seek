import { describe, expect, it } from "vitest";

import type { AABB, Vec3Like } from "../../src/inspector/navData";
import { WORLD_SCALE } from "../../src/inspector/navData";
import { SpatialValidatorImpl } from "../../src/inspector/SpatialValidatorImpl";
import { box, SHOP_FLOOR, testSettings, WALL } from "./navFixture";

/**
 * The truth table the authoritative validator must satisfy (§28.4, §28.5). It
 * replaces PERMISSIVE_SPATIAL_VALIDATOR, which answered yes to everything, so
 * these cases are the whole of what the simulation now relies on.
 *
 * Every distance here is a share of the two reaches under test rather than a
 * number of metres, so a case that is meant to fail on line of sight cannot
 * quietly start failing on range when the scale is retuned.
 */

const settings = testSettings();
const ACCUSE_M = settings.accusationDistance;
const FOCUS_M = settings.inspectorFocusDistance;

const EYE: Vec3Like = { x: 0, y: WORLD_SCALE.eyeHeight, z: 0 };

/**
 * A prop the size of a player, standing due south of the eye. Its nearest face
 * is exactly `metres` away, because the eye's own height falls inside the box's
 * height range.
 */
function propSouth(metres: number): AABB {
  const half = WORLD_SCALE.playerRadius;
  return box(-half, 0, metres, half, WORLD_SCALE.playerHeight, metres + 2 * half);
}

/** Both furniture and an inspectable, which must not occlude itself. */
const CABINET = box(-ACCUSE_M * 0.6, 0, -0.12, -ACCUSE_M * 0.4, WORLD_SCALE.playerHeight, 0.12);

/** Just past the wall, which stands between x = 1 and x = 1.2. */
const BEHIND_WALL = box(1.25, 0, -0.12, 1.45, WORLD_SCALE.playerHeight, 0.12);

/**
 * Close enough to the wall that the gun reaches the far side of it, so a
 * refusal there is the wall talking and not the range.
 */
const EYE_AT_WALL: Vec3Like = { x: BEHIND_WALL.min.x - ACCUSE_M * 0.6, y: EYE.y, z: 0 };

const TARGETS: Readonly<Record<string, AABB>> = {
  adjacent: propSouth(ACCUSE_M * 0.5),
  behindWall: BEHIND_WALL,
  beyondAccusation: propSouth((ACCUSE_M + FOCUS_M) / 2),
  beyondFocus: propSouth(FOCUS_M * 1.5),
  cabinet: CABINET,
};

function validator(eye: Vec3Like | null = EYE): SpatialValidatorImpl {
  return new SpatialValidatorImpl({
    floors: [SHOP_FLOOR],
    blockers: [WALL, CABINET],
    accusationDistance: settings.accusationDistance,
    focusDistance: settings.inspectorFocusDistance,
    inspectorEye: (inspectorId) => (inspectorId === "inspector-1" ? eye : null),
    objectBounds: (objectId) => TARGETS[objectId] ?? null,
  });
}

describe("SpatialValidatorImpl.canAccuse", () => {
  it("accepts an adjacent target in clear view", () => {
    expect(validator().canAccuse("inspector-1", "adjacent")).toEqual({ ok: true });
  });

  it("refuses a target behind a wall", () => {
    expect(validator(EYE_AT_WALL).canAccuse("inspector-1", "behindWall")).toEqual({
      ok: false,
      reason: "no_line_of_sight",
    });
  });

  it("refuses a target beyond the accusation distance", () => {
    expect(validator().canAccuse("inspector-1", "beyondAccusation")).toEqual({
      ok: false,
      reason: "out_of_range",
    });
  });

  it("accepts furniture that is its own collider", () => {
    expect(validator().canAccuse("inspector-1", "cabinet")).toEqual({ ok: true });
  });

  it("refuses an inspector whose position the authority does not know", () => {
    expect(validator().canAccuse("inspector-unknown", "adjacent")).toEqual({
      ok: false,
      reason: "inspector_position_unknown",
    });
    expect(validator(null).canAccuse("inspector-1", "adjacent")).toEqual({
      ok: false,
      reason: "inspector_position_unknown",
    });
  });

  it("refuses a target the registry has no bounds for", () => {
    expect(validator().canAccuse("inspector-1", "not-a-thing")).toEqual({
      ok: false,
      reason: "target_bounds_unknown",
    });
  });

  it("lets an inspector who walked around the wall accuse what it hid", () => {
    const beside = validator({ x: BEHIND_WALL.max.x + ACCUSE_M * 0.4, y: EYE.y, z: 0 });
    expect(beside.canAccuse("inspector-1", "behindWall")).toEqual({ ok: true });
  });
});

describe("SpatialValidatorImpl.canObserve", () => {
  it("reaches further than an accusation but no further than the focus distance", () => {
    const spatial = validator();
    expect(spatial.canObserve("inspector-1", "beyondAccusation")).toEqual({ ok: true });
    expect(spatial.canObserve("inspector-1", "beyondFocus")).toEqual({
      ok: false,
      reason: "out_of_range",
    });
  });

  it("still requires line of sight", () => {
    expect(validator().canObserve("inspector-1", "behindWall")).toEqual({
      ok: false,
      reason: "no_line_of_sight",
    });
  });
});

describe("SpatialValidatorImpl.canOccupy", () => {
  it("accepts a root standing on the floor inside the room", () => {
    expect(validator().canOccupy("player-7", [0, 0, 0])).toEqual({ ok: true });
  });

  it("accepts a root resting on top of furniture", () => {
    const onTop = (CABINET.min.x + CABINET.max.x) / 2;
    expect(validator().canOccupy("player-7", [onTop, CABINET.max.y, 0])).toEqual({ ok: true });
  });

  it("refuses a root buried inside a wall", () => {
    expect(validator().canOccupy("player-7", [1.1, 1, 0])).toEqual({
      ok: false,
      reason: "inside_blocked_geometry",
    });
  });

  it("refuses a root outside the room, under the floor, or in the ceiling", () => {
    const spatial = validator();
    expect(spatial.canOccupy("player-7", [9, 0, 0]).reason).toBe("outside_playable_area");
    expect(spatial.canOccupy("player-7", [0, -2, 0]).reason).toBe("outside_playable_area");
    expect(spatial.canOccupy("player-7", [0, 6, 0]).reason).toBe("outside_playable_area");
  });

  it("refuses a position that is not a finite number", () => {
    const spatial = validator();
    expect(spatial.canOccupy("player-7", [Number.NaN, 0, 0]).ok).toBe(false);
    expect(spatial.canOccupy("player-7", [0, Number.POSITIVE_INFINITY, 0]).ok).toBe(false);
  });
});

describe("SpatialValidatorImpl determinism", () => {
  it("returns the same decision for the same inputs, whatever the call order", () => {
    const spatial = validator();
    const ids = ["adjacent", "behindWall", "beyondAccusation", "cabinet", "not-a-thing"];

    const forward = ids.map((id) => JSON.stringify(spatial.canAccuse("inspector-1", id)));
    const backward = [...ids]
      .reverse()
      .map((id) => JSON.stringify(spatial.canAccuse("inspector-1", id)))
      .reverse();
    expect(backward).toEqual(forward);

    for (let i = 0; i < 200; i += 1) {
      expect(ids.map((id) => JSON.stringify(spatial.canAccuse("inspector-1", id)))).toEqual(forward);
    }
  });

  it("does not depend on the order blockers were supplied in", () => {
    const straight = new SpatialValidatorImpl({
      blockers: [WALL, CABINET],
      accusationDistance: settings.accusationDistance,
      focusDistance: settings.inspectorFocusDistance,
      inspectorEye: () => EYE,
      objectBounds: (objectId) => TARGETS[objectId] ?? null,
    });
    const reversed = new SpatialValidatorImpl({
      floors: [SHOP_FLOOR],
      blockers: [CABINET, WALL],
      accusationDistance: settings.accusationDistance,
      focusDistance: settings.inspectorFocusDistance,
      inspectorEye: () => EYE,
      objectBounds: (objectId) => TARGETS[objectId] ?? null,
    });

    for (const id of Object.keys(TARGETS)) {
      expect(reversed.canAccuse("inspector-1", id)).toEqual(straight.canAccuse("inspector-1", id));
      expect(reversed.canObserve("inspector-1", id)).toEqual(straight.canObserve("inspector-1", id));
    }
  });

  it("is a pure function of the data it is constructed from", () => {
    const first = validator();
    const second = validator();
    for (const id of Object.keys(TARGETS)) {
      expect(second.canAccuse("inspector-1", id)).toEqual(first.canAccuse("inspector-1", id));
    }
  });
});
