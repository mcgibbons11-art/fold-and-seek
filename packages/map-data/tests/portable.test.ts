import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MATCH_SETTINGS } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import {
  NAV_DATA,
  PROP_FOCUS_BOUNDS,
  SHOP_PLACEMENTS,
  SOLID_PROP_VOLUMES,
  SpatialValidatorImpl,
  buildObjectRegistry,
  CURIOSITY_SHOP_RECORDS,
} from "../src/index";

/**
 * What this package promises the dedicated server: that it runs at all.
 *
 * The Colyseus server imports the shop in Node, where there is no document, no
 * WebGL context and no Three.js. That is enforced twice, and deliberately so.
 * The package's tsconfig omits the DOM lib, which catches a browser global at
 * compile time; this file catches an import of a renderer, which a tsconfig
 * cannot, because `three` brings its own types and would typecheck perfectly
 * before failing on a server nobody is watching.
 */

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(): readonly string[] {
  return readdirSync(SOURCE_DIR).filter((name) => name.endsWith(".ts"));
}

describe("map-data is portable", () => {
  it("has sources to check, so a passing scan means something", () => {
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  it("imports no renderer", () => {
    // A tsconfig cannot catch this. `three` ships its own types, so a package
    // that imported it would typecheck perfectly and then fail on a server
    // nobody is watching.
    for (const name of sourceFiles()) {
      const source = readFileSync(join(SOURCE_DIR, name), "utf8");
      expect(source, name).not.toMatch(/from\s+"three/);
      expect(source, name).not.toMatch(/require\(\s*"three/);
    }
  });

  it("loaded in an environment with no DOM at all", () => {
    // The imports at the top of this file are the assertion; this states the
    // condition they ran under, so a suite quietly moved to jsdom stops
    // proving anything and says so.
    // Not `navigator`, which Node has defined as a global since v21.
    const globals = globalThis as unknown as Record<string, unknown>;
    for (const name of ["document", "window", "HTMLCanvasElement", "WebGL2RenderingContext"]) {
      expect(globals[name], name).toBeUndefined();
    }
    expect(NAV_DATA.floors.length).toBeGreaterThan(0);
  });
});

describe("map-data answers the questions an authority asks", () => {
  const validator = new SpatialValidatorImpl({
    floors: NAV_DATA.floors,
    blockers: NAV_DATA.blockers,
    forbiddenOccupancy: [NAV_DATA.securityOffice],
    solidProps: SOLID_PROP_VOLUMES,
    accusationDistance: DEFAULT_MATCH_SETTINGS.accusationDistance,
    focusDistance: DEFAULT_MATCH_SETTINGS.inspectorFocusDistance,
    inspectorEye: () => null,
    objectBounds: (objectId) => PROP_FOCUS_BOUNDS.get(objectId) ?? null,
  });

  it("publishes a floor, a blocker and a prop box for every accusable target", () => {
    expect(NAV_DATA.floors.length).toBeGreaterThan(0);
    expect(NAV_DATA.blockers.length).toBeGreaterThan(0);
    for (const entry of buildObjectRegistry().objects) {
      expect(PROP_FOCUS_BOUNDS.get(entry.objectId), entry.objectId).toBeDefined();
    }
  });

  it("refuses an Inspector it has never heard from rather than assuming one", () => {
    const target = buildObjectRegistry().objects[0];
    expect(target).toBeDefined();
    const decision = validator.canAccuse("nobody", target?.objectId ?? "");
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("inspector_position_unknown");
  });

  it("gives every accusable prop a box with volume in it", () => {
    // A box the extraction had collapsed would be a target nothing could ever
    // hit. Where the boxes *are* is asserted against the client's own copy in
    // apps/client/tests/maps/mapDataParity.test.ts, prop by prop, which is the
    // comparison that matters: the two authorities must agree, and neither is
    // required to sit inside the shop shell, since a wall shelf overhangs the
    // wall it hangs on.
    const registered = new Set(buildObjectRegistry().objects.map((entry) => entry.objectId));
    expect(registered.size).toBeGreaterThan(0);
    for (const record of CURIOSITY_SHOP_RECORDS) {
      if (!registered.has(record.objectId)) continue;
      const box = record.focusBounds;
      expect(box.max.x - box.min.x, `${record.objectId} width`).toBeGreaterThan(0);
      expect(box.max.y - box.min.y, `${record.objectId} height`).toBeGreaterThan(0);
      expect(box.max.z - box.min.z, `${record.objectId} depth`).toBeGreaterThan(0);
    }
  });

  it("stands a body on the shop floor and refuses one under it", () => {
    expect(validator.canOccupy("probe", [0, 0, 0]).ok).toBe(true);
    expect(validator.canOccupy("probe", [0, -4, 0])).toEqual({
      ok: false,
      reason: "outside_playable_area",
    });
  });

  it("keeps Mimic roots out of the Security Office", () => {
    const office = NAV_DATA.securityOffice;
    const x = (office.min.x + office.max.x) * 0.5;
    const z = (office.min.z + office.max.z) * 0.5;
    expect(validator.canOccupy("mimic", [x, office.min.y, z])).toEqual({
      ok: false,
      reason: "forbidden_area",
    });
  });

  it("refuses a root buried inside a bottle but lets one lean against it", () => {
    // Every solid decor family contributes a volume, and the volumes come from
    // the same authored focus boxes the reticle brackets.
    expect(SOLID_PROP_VOLUMES.length).toBeGreaterThan(50);

    const urn = SHOP_PLACEMENTS.find((placement) => placement.objectId === "window_urn_02");
    expect(urn).toBeDefined();
    if (urn === undefined) return;
    const [x, y, z] = urn.position;
    const [width, height] = urn.focus;
    const inside = validator.canOccupy("mimic", [x, y + height / 2, z]);
    expect(inside).toEqual({ ok: false, reason: "inside_blocked_geometry" });
    // Just beside the urn on the same floor is still a hiding place.
    expect(validator.canOccupy("mimic", [x + width / 2 + 0.1, y, z]).ok).toBe(true);
  });
});
