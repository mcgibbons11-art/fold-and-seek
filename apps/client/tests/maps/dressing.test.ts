import { describe, expect, it } from "vitest";

import { QUALITY_PRESETS, QUALITY_TIER_ORDER, qualitySettingsFor } from "../../src/rendering/quality";
import {
  fillIrradiance,
  planPracticalLights,
  PRACTICALS_BY_RANK,
  SHOP_FILL_RIG,
} from "../../src/world/maps/lighting";
import { PRACTICAL_PLACEMENTS, SHOP_PLACEMENTS } from "../../src/world/maps/placements";
import { FLOOR_CLUTTER, type ClutterKind } from "../../src/world/maps/props/clutter";
import { NAV_BLOCKERS } from "../../src/world/maps/nav";
import { buildMapObjects, buildObjectRegistry } from "../../src/world/maps/registry";
import { isShopSwatch } from "../../src/world/maps/swatches";
import { FLOOR_PLAN, SECURITY_OFFICE_BOUNDS } from "../../src/world/maps/zones";

/**
 * What the renderer does to a linear colour before a player sees it, so the
 * readability numbers below are display levels rather than radiometry.
 *
 * `RendererManager` sets ACES filmic tone mapping at exposure 1.15 and an sRGB
 * output colour space; this is three's own ACES fit, matrices and all, because
 * a cheaper curve would put these thresholds off by tens of levels and the
 * whole check would be decoration.
 */
const TONE_MAPPING_EXPOSURE = 1.15;

const ACES_INPUT: readonly (readonly [number, number, number])[] = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const ACES_OUTPUT: readonly (readonly [number, number, number])[] = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

function transform(
  matrix: readonly (readonly [number, number, number])[],
  v: readonly [number, number, number],
): [number, number, number] {
  return [0, 1, 2].map((row) => {
    const r = matrix[row] as readonly [number, number, number];
    return r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  }) as [number, number, number];
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** Display level 0..1 a linear colour lands on, as a perceived grey. */
function displayLevel(linear: readonly [number, number, number]): number {
  const exposed = linear.map((c) => (c * TONE_MAPPING_EXPOSURE) / 0.6) as [number, number, number];
  const fitted = transform(ACES_INPUT, exposed).map((x) => {
    const a = x * (x + 0.0245786) - 0.000090537;
    const b = x * (0.983729 * x + 0.432951) + 0.238081;
    return a / b;
  }) as [number, number, number];
  const out = transform(ACES_OUTPUT, fitted).map((x) => linearToSrgb(Math.min(Math.max(x, 0), 1)));
  return 0.2126 * (out[0] ?? 0) + 0.7152 * (out[1] ?? 0) + 0.0722 * (out[2] ?? 0);
}

/** Diffuse radiance a surface of the given albedo returns under an irradiance. */
function diffuse(irradiance: readonly [number, number, number], albedo: number): [number, number, number] {
  return [
    (irradiance[0] * albedo) / Math.PI,
    (irradiance[1] * albedo) / Math.PI,
    (irradiance[2] * albedo) / Math.PI,
  ];
}

/** Evenly spread unit normals, by the Fibonacci sphere. */
function sampleNormals(count: number): readonly (readonly [number, number, number])[] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(Math.max(1 - y * y, 0));
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    out.push([Math.cos(phi) * radius, y, Math.sin(phi) * radius]);
  }
  return out;
}

/** A painted white body, and the mid grey it has to be told apart from. */
const WHITE_ALBEDO = 0.85;
const MID_ALBEDO = 0.18;
/**
 * Normals below this are undersides. A player never compares two objects by
 * the faces pointing at the floorboards, so they are outside the contract.
 */
const MIN_COMPARABLE_TILT = -0.35;

describe("Curiosity Shop fill rig", () => {
  const comparable = sampleNormals(600).filter((n) => n[1] >= MIN_COMPARABLE_TILT);

  it("keeps a white body readable whichever way it faces", () => {
    // The game asks the player to compare a painted body against the props
    // beside it, so the unshadowed fill alone — no practical, no moon, no
    // environment map — has to clear the floor everywhere a player can stand.
    let worst = 1;
    for (const normal of comparable) {
      worst = Math.min(worst, displayLevel(diffuse(fillIrradiance(normal), WHITE_ALBEDO)));
    }
    expect(worst).toBeGreaterThan(0.16);
  });

  it("separates a white body from a mid tone whichever way it faces", () => {
    let narrowest = 1;
    for (const normal of comparable) {
      const irradiance = fillIrradiance(normal);
      const white = displayLevel(diffuse(irradiance, WHITE_ALBEDO));
      const mid = displayLevel(diffuse(irradiance, MID_ALBEDO));
      narrowest = Math.min(narrowest, white - mid);
    }
    // Thirty levels apart at the worst normal. Below roughly twenty the two
    // read as the same object under a glance, which is the whole game.
    expect(narrowest).toBeGreaterThan(0.12);
  });

  it("stays fill rather than floodlighting", () => {
    // The lamps have to keep carving pools, or a room full of authored
    // practicals stops meaning anything. The measure is how far a warm
    // practical still out-lights the entire fill rig: that radius is the pool.
    // It is taken on irradiance rather than on display levels because the tone
    // curve compresses the top of the range hard, and how much of that a player
    // sees depends on exposure rather than on the rig being tuned right.
    const luminance = (c: readonly [number, number, number]): number =>
      0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const warm: [number, number, number] = [1, 0.4342, 0.1329];

    let brightestFill = 0;
    for (const normal of comparable) {
      brightestFill = Math.max(brightestFill, luminance(fillIrradiance(normal)));
    }
    // A practical is authored at intensity 6 and falls off with the square.
    const poolRadius = Math.sqrt((luminance(warm) * 6) / brightestFill);

    // Under a metre and the lamps would be lost in the fill; past four and the
    // fill would never be what a player is reading by.
    expect(poolRadius).toBeGreaterThan(1.5);
    expect(poolRadius).toBeLessThan(4);
  });

  it("lights the two sides of a body in different hues", () => {
    // Four-way fill exists so a silhouette keeps a warm edge against a cool
    // one. A rig that reached the same level with flat ambient would pass the
    // readability checks above and read as fog, so the hue split is pinned too.
    const towardWindow = fillIrradiance([-1, 0, -1]);
    const towardOffice = fillIrradiance([1, 0, 1]);
    const warmth = (c: readonly [number, number, number]): number => c[0] / c[2];
    expect(warmth(towardWindow)).toBeGreaterThan(warmth(towardOffice) * 1.5);
  });

  it("adds no shadow-casting light", () => {
    // The shadowed-light budget is tier-gated and spent on the moon key and the
    // counter spot. The fill rig is free precisely because none of it casts.
    expect(SHOP_FILL_RIG.directionals.length).toBe(2);
  });
});

describe("Curiosity Shop practical light budget", () => {
  it("holds the WebGPU path to a handful of live point lights", () => {
    // Three shades every punctual light in a loop and its WebGPU node-material
    // path is far weaker at it than WebGL 2: the shop measured 5.4 fps at the
    // high tier on WebGPU against roughly 21 on WebGL 2 with the same lamps.
    for (const tier of QUALITY_TIER_ORDER) {
      const live = planPracticalLights(qualitySettingsFor(tier, "webgpu").maxPracticalLights).live;
      expect(live, tier).toBeLessThanOrEqual(6);
    }
  });

  it("holds the WebGL 2 path under the program size that was losing the device", () => {
    // WebGL 2 has the room's frame rate and pays for the lights in program size
    // instead: three unrolls the light loop, and an Intel driver was refusing to
    // link the result and taking the context with it. The budget is therefore
    // looser than WebGPU's and still well under the seventeen lamps that failed.
    for (const tier of QUALITY_TIER_ORDER) {
      const settings = qualitySettingsFor(tier, "webgl2");
      const webgpu = qualitySettingsFor(tier, "webgpu");
      expect(settings.maxPracticalLights, tier).toBeLessThanOrEqual(10);
      expect(settings.maxPracticalLights, tier).toBeGreaterThanOrEqual(webgpu.maxPracticalLights);
      expect(settings.maxPracticalLights, tier).toBeLessThanOrEqual(
        QUALITY_PRESETS[tier].maxPracticalLights,
      );
    }

    // The lamps that lose their light keep their pools on this backend too,
    // which is the part that decides whether the shop still reads as lit.
    const high = planPracticalLights(qualitySettingsFor("high", "webgl2").maxPracticalLights);
    expect(high.live).toBeLessThan(PRACTICALS_BY_RANK.length);
    expect(high.live + high.unlit).toBe(PRACTICALS_BY_RANK.length);
    expect(high.pools).toBeGreaterThan(0);
  });

  it("stands a pool in for every lamp that loses its light, bar the sconces", () => {
    // A lamp with no light stops lighting its corner, which would undo the fill
    // work. Only wall sconces go without: they wash the wall beside them and a
    // disc on the floor under one would be a lie.
    const budget = qualitySettingsFor("high", "webgpu").maxPracticalLights;
    const plan = planPracticalLights(budget);
    const unlitSconces = PRACTICALS_BY_RANK.slice(plan.live).filter(
      (placement) => placement.variant === "wall_sconce",
    ).length;

    expect(plan.live + plan.unlit).toBe(PRACTICALS_BY_RANK.length);
    expect(plan.pools).toBe(plan.unlit - unlitSconces);
    expect(plan.pools).toBeGreaterThan(0);
  });

  it("spends its lights on space a player can occupy", () => {
    // The Security Office is sealed: no walkable floor, every prop blocked for
    // accusation. Its pendant carries the highest authored priority in the
    // manifest, so on a six-light budget the most valuable light in the room
    // went to the one room nobody can enter.
    const inOffice = (placement: (typeof PRACTICALS_BY_RANK)[number]): boolean =>
      placement.position[0] >= SECURITY_OFFICE_BOUNDS.min.x &&
      placement.position[0] <= SECURITY_OFFICE_BOUNDS.max.x &&
      placement.position[2] >= SECURITY_OFFICE_BOUNDS.min.z &&
      placement.position[2] <= SECURITY_OFFICE_BOUNDS.max.z;

    expect(PRACTICAL_PLACEMENTS.some(inOffice)).toBe(true);
    const live = planPracticalLights(qualitySettingsFor("high", "webgpu").maxPracticalLights).live;
    expect(PRACTICALS_BY_RANK.slice(0, live).some(inOffice)).toBe(false);

    // Every sealed-room lamp sorts behind every playable one, and within each
    // group the authored priority still decides.
    const playable = PRACTICALS_BY_RANK.filter((placement) => !inOffice(placement));
    const priorities = playable.map((placement) => placement.practical?.priority ?? 0);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    expect(PRACTICALS_BY_RANK.slice(0, playable.length)).toEqual(playable);
  });

  it("gives up lamps monotonically as the budget falls", () => {
    // The pool instances are the leading ones of a single mesh, so raising the
    // budget must only ever draw fewer of them.
    let previous = Number.POSITIVE_INFINITY;
    for (let budget = 0; budget <= PRACTICALS_BY_RANK.length; budget += 1) {
      const pools = planPracticalLights(budget).pools;
      expect(pools).toBeLessThanOrEqual(previous);
      previous = pools;
    }
    expect(planPracticalLights(PRACTICALS_BY_RANK.length).pools).toBe(0);
  });

  it("keeps every lit fixture whatever the budget", () => {
    // Only the THREE.PointLight is dropped. The bulb and shade geometry belongs
    // to the prop, is built from SHOP_PLACEMENTS by the lamp builders in
    // props/lamps.ts, and those pull BULB_MATERIAL and LAMPSHADE_MATERIAL
    // unconditionally, so no budget can take a glow away. What this pins is the
    // arithmetic: a cut moves a fixture between live and unlit and never out.
    const fixtures = PRACTICALS_BY_RANK.length;
    for (let budget = 0; budget <= fixtures + 4; budget += 1) {
      const plan = planPracticalLights(budget);
      expect(plan.live + plan.unlit, `budget ${String(budget)}`).toBe(fixtures);
      expect(plan.live).toBeLessThanOrEqual(fixtures);
      expect(plan.unlit).toBeGreaterThanOrEqual(0);
    }
    // The extreme the WebGPU path is walking toward: no live lights at all, and
    // every fixture still present, still glowing, most of them over a pool.
    const dark = planPracticalLights(0);
    expect(dark.live).toBe(0);
    expect(dark.unlit).toBe(fixtures);
    expect(dark.pools).toBeGreaterThan(0);
  });

  it("returns one settings object per tier and backend", () => {
    // GameHost decides whether a tier change is worth re-applying down the
    // whole world by comparing settings by identity, so a capped settings
    // object built fresh on every call would re-apply quality forever. Both
    // backends cap now, so the memo has to be keyed by both: keyed by tier
    // alone, whichever backend asked first would answer for the other.
    for (const tier of QUALITY_TIER_ORDER) {
      expect(qualitySettingsFor(tier, "webgpu"), tier).toBe(qualitySettingsFor(tier, "webgpu"));
      expect(qualitySettingsFor(tier, "webgl2"), tier).toBe(qualitySettingsFor(tier, "webgl2"));
      expect(qualitySettingsFor(tier, "webgpu"), tier).not.toBe(qualitySettingsFor(tier, "webgl2"));
      expect(qualitySettingsFor(tier, "webgpu").maxPracticalLights, tier).toBeLessThan(
        qualitySettingsFor(tier, "webgl2").maxPracticalLights,
      );
    }
  });
});

interface Footprint {
  readonly x: number;
  readonly z: number;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly rotationY: number;
}

/**
 * Floor-standing prop footprints, re-derived here from the authored manifest
 * rather than imported from the scatter, so the placement rules are checked
 * against the map instead of against the code that laid the scatter out.
 */
const FLOOR_PROPS: readonly Footprint[] = SHOP_PLACEMENTS.filter((placement) => placement.position[1] < 0.06).map(
  (placement) => ({
    x: placement.position[0],
    z: placement.position[2],
    halfWidth: placement.focus[0] / 2,
    halfDepth: placement.focus[2] / 2,
    rotationY: placement.rotationY,
  }),
);

function insideFootprint(footprint: Footprint, x: number, z: number): boolean {
  const dx = x - footprint.x;
  const dz = z - footprint.z;
  const cos = Math.cos(-footprint.rotationY);
  const sin = Math.sin(-footprint.rotationY);
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  return Math.abs(localX) <= footprint.halfWidth && Math.abs(localZ) <= footprint.halfDepth;
}

describe("Curiosity Shop floor clutter", () => {
  it("dresses the floor without becoming gameplay data", () => {
    expect(FLOOR_CLUTTER.length).toBeGreaterThan(60);

    // The registry is a pure function of the authored manifest. If a piece of
    // dressing ever reached it, an Inspector could spend a warrant on a coin.
    const registry = buildObjectRegistry();
    const authored = new Set(SHOP_PLACEMENTS.map((placement) => placement.objectId));
    for (const object of registry.objects) {
      expect(authored.has(object.objectId), object.objectId).toBe(true);
    }
    expect(registry.objects.length).toBe(
      buildMapObjects().filter((entry) => entry.accusationPolicy === "allowed").length,
    );
    expect(buildMapObjects().length).toBe(SHOP_PLACEMENTS.length);
  });

  it("never becomes an obstacle", () => {
    // Debris is walked over, not around. Nothing in the scatter is a blocker,
    // and nothing sits inside one either, which is also what keeps a scrap of
    // paper from being drawn inside a wall.
    const groundBlockers = NAV_BLOCKERS.filter((blocker) => blocker.min.y <= 0.02 && blocker.max.y >= 0.02);
    expect(groundBlockers.length).toBeGreaterThan(0);
    for (const piece of FLOOR_CLUTTER) {
      const [x, , z] = piece.position;
      const trapped = groundBlockers.some(
        (blocker) => x >= blocker.min.x && x <= blocker.max.x && z >= blocker.min.z && z <= blocker.max.z,
      );
      expect(trapped, `${piece.kind} at ${x.toFixed(2)},${z.toFixed(2)}`).toBe(false);
    }
  });

  it("lies on walkable floor, clear of every prop", () => {
    for (const piece of FLOOR_CLUTTER) {
      const [x, y, z] = piece.position;
      const walkable = FLOOR_PLAN.some(
        (box) => x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z,
      );
      expect(walkable, `${piece.kind} at ${x.toFixed(2)},${z.toFixed(2)}`).toBe(true);
      expect(FLOOR_PROPS.some((prop) => insideFootprint(prop, x, z))).toBe(false);
      // Resting on the floor rather than floating over it or sunk into it.
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(0.02);
    }
  });

  it("costs a handful of draw calls, not hundreds", () => {
    // Every piece of a kind shares one geometry and one material, so the
    // scatter's whole cost is one batched draw per kind however many pieces
    // land. The tint that makes them differ rides instance colours.
    const kinds = new Set<ClutterKind>(FLOOR_CLUTTER.map((piece) => piece.kind));
    expect(kinds.size).toBeLessThanOrEqual(8);
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });
});

describe("Curiosity Shop floorboards", () => {
  it("publishes the floor tones as sampleable swatches", () => {
    // The floor is lighter than the cabinet walnut standing on it, so it wears
    // its own swatches. Sampling has to hand back the colour actually rendered,
    // which is why this is not a reuse of walnut with different maps.
    for (const id of ["floorboard_oak_02", "floorboard_bleached_03", "floorboard_stained_01"]) {
      expect(isShopSwatch(id), id).toBe(true);
    }
  });
});
