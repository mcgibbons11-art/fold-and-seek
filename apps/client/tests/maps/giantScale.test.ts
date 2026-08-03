import { DEFAULT_MATCH_SETTINGS, PLAYER_HEIGHT_M, STARTER_ARRANGEMENT_IDS } from "@foldseek/shared";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import type { AABB, WalkableSurface } from "../../src/inspector/navData";
import { WORLD_SCALE } from "../../src/inspector/navData";
import { applyDisguiseStateToPose, createStarterArrangement } from "../../src/mimic/disguiseState";
import { createPoseState } from "../../src/mimic/ikSolver";
import { MimicVisual } from "../../src/mimic/visual/MimicVisual";
import { NAV_BLOCKERS, WALKABLE_SURFACES } from "../../src/world/maps/nav";
import { SHOP_MAX_X, SHOP_MAX_Z, SHOP_MIN_X, SHOP_MIN_Z } from "../../src/world/maps/zones";

/**
 * The point of the giant scale is that a player can disappear into the shop's
 * furniture, so these check the one thing that makes the fantasy work: a folded
 * Mimic fits into the spaces the map already has, and the gun cannot reach
 * across the room to spoil the search.
 *
 * Every measurement is taken off a real `MimicVisual` in world metres. Nothing
 * is normalised, which is the point: the rig converts its authored units once,
 * so a body built here is the size it will be in the shop.
 */

const SHOP_LONG_AXIS_M = SHOP_MAX_X - SHOP_MIN_X;
const SHOP_SHORT_AXIS_M = SHOP_MAX_Z - SHOP_MIN_Z;

/** Ignores a blocker whose base merely touches the ledge it sits on. */
const LEDGE_EPSILON_M = 0.01;

interface Measured {
  readonly id: string;
  readonly size: THREE.Vector3;
  /** Highest point of the body, which is the top of the head when upright. */
  readonly top: number;
  readonly sphereRadius: number;
  /** The shells alone, without sockets, panel plates or markers. */
  readonly shellSize: THREE.Vector3;
}

/** Bounding box and bounding sphere of one starter arrangement, in metres. */
function measure(id: (typeof STARTER_ARRANGEMENT_IDS)[number]): Measured {
  const state = createStarterArrangement(id);
  const pose = createPoseState();
  applyDisguiseStateToPose(state, pose);
  const visual = new MimicVisual();
  visual.applyForms(pose);
  visual.applyPanels(state.panels);
  visual.applyPose(pose);
  visual.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(visual.root);
  const shells = new THREE.Box3();
  for (const mesh of visual.segmentMeshes) shells.expandByObject(mesh);
  const measured = {
    id,
    size: box.getSize(new THREE.Vector3()),
    top: box.max.y,
    sphereRadius: box.getBoundingSphere(new THREE.Sphere()).radius,
    shellSize: shells.getSize(new THREE.Vector3()),
  };
  visual.dispose();
  return measured;
}

const ARRANGEMENTS = STARTER_ARRANGEMENT_IDS.map(measure);

/** Standing at attention, which is what "player height" has to mean. */
const UPRIGHT = ARRANGEMENTS.find((entry) => entry.id === "upright") as Measured;

function surfaceById(id: string): WalkableSurface {
  const surface = WALKABLE_SURFACES.find((entry) => entry.id === id);
  if (surface === undefined) throw new Error(`no walkable surface "${id}"`);
  return surface;
}

/** True when two boxes overlap in the XZ plane. */
function overlapsXZ(a: AABB, b: AABB): boolean {
  return a.min.x < b.max.x && b.min.x < a.max.x && a.min.z < b.max.z && b.min.z < a.max.z;
}

/**
 * Free height over a ledge: the underside of the lowest blocker standing above
 * it and over its footprint. Read from the blockers rather than from the
 * surface's own `clearance` note, so the annotation is checked too.
 */
function headroomOver(surface: WalkableSurface): number {
  const top = surface.bounds.max.y;
  let ceiling = Number.POSITIVE_INFINITY;
  for (const blocker of NAV_BLOCKERS) {
    if (blocker.min.y <= top + LEDGE_EPSILON_M) continue;
    if (!overlapsXZ(blocker, surface.bounds)) continue;
    if (blocker.min.y < ceiling) ceiling = blocker.min.y;
  }
  return ceiling - top;
}

/**
 * Three hiding places on three different props, each a real ledge with real
 * furniture over it: the bay under the workshop bench, the space under the
 * office desk, and the second board of the steel rack with the third above it.
 */
const ANCHOR_IDS = ["crawl_workbench", "crawl_office_desk", "shelving_board_2"] as const;

describe("a folded Mimic at player scale", () => {
  it("fits under every anchor surface the map offers as cover", () => {
    for (const anchorId of ANCHOR_IDS) {
      const surface = surfaceById(anchorId);
      const headroom = headroomOver(surface);
      expect(headroom, `${anchorId} has no ceiling over it`).toBeLessThan(Number.POSITIVE_INFINITY);

      const footprintX = surface.bounds.max.x - surface.bounds.min.x;
      const footprintZ = surface.bounds.max.z - surface.bounds.min.z;

      for (const arrangement of ARRANGEMENTS) {
        const where = `${arrangement.id} under ${anchorId}`;
        expect(arrangement.size.y, `${where}: too tall`).toBeLessThan(headroom);
        expect(arrangement.size.x, `${where}: too wide`).toBeLessThan(footprintX);
        expect(arrangement.size.z, `${where}: too deep`).toBeLessThan(footprintZ);
      }
    }
  });

  it("clears the widest bay whichever way it is turned", () => {
    // The bounding sphere ignores orientation, so passing it means the body
    // fits under the bench however the owner has spun it.
    const widest = Math.max(...ARRANGEMENTS.map((entry) => entry.sphereRadius));
    expect(widest * 2).toBeLessThan(headroomOver(surfaceById("crawl_workbench")));
  });

  it("measures no larger than the body it is drawing", () => {
    // `Box3.setFromObject` counts hidden children, and a stowed panel plate used
    // to sit at its build scale of one metre. That box is what the reticle
    // brackets and what the authority checks a shot against, so a disguise came
    // with an invisible slab around it several times its own size.
    for (const arrangement of ARRANGEMENTS) {
      for (const axis of ["x", "y", "z"] as const) {
        expect(
          arrangement.size[axis],
          `${arrangement.id}: bounds are wider than the shells on ${axis}`,
        ).toBeLessThan(arrangement.shellSize[axis] * 1.25 + LEDGE_EPSILON_M);
      }
    }
  });

  it("stands at exactly player height when it is not folded at all", () => {
    // Measured to the crown with the root on the floor. The box is a couple of
    // millimetres shorter, because the soles do not quite touch in the rest
    // pose, so the head is what the claim is made against.
    expect(UPRIGHT.top).toBeCloseTo(PLAYER_HEIGHT_M, 6);
  });
});

describe("the shipped reach settings", () => {
  it("keeps the gun well short of a cross-room shot", () => {
    expect(DEFAULT_MATCH_SETTINGS.accusationDistance).toBeLessThan(SHOP_LONG_AXIS_M);
    // A quarter of the long axis is the real bar: merely being under 15 m would
    // still let an Inspector clear half the shop without walking.
    expect(DEFAULT_MATCH_SETTINGS.accusationDistance).toBeLessThan(SHOP_LONG_AXIS_M / 4);
  });

  it("orders the reaches so spotting something always costs a walk toward it", () => {
    expect(DEFAULT_MATCH_SETTINGS.accusationDistance).toBeLessThan(
      DEFAULT_MATCH_SETTINGS.inspectorFocusDistance,
    );
    expect(DEFAULT_MATCH_SETTINGS.inspectorFocusDistance).toBeLessThan(SHOP_SHORT_AXIS_M / 2);
  });

  it("keeps the hider agile after the hunt starts", () => {
    expect(DEFAULT_MATCH_SETTINGS.hiderCreepSpeed).toBeGreaterThan(
      DEFAULT_MATCH_SETTINGS.inspectorMoveSpeed,
    );
  });

  it("takes its player height from the one shared constant", () => {
    expect(WORLD_SCALE.playerHeight).toBe(PLAYER_HEIGHT_M);
  });
});
