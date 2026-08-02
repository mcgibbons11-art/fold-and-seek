import * as THREE from "three/webgpu";
import { NAV_BLOCKERS } from "../nav";
import { SHOP_PLACEMENTS } from "../placements";
import {
  CABINET_BLOCKS,
  FLOOR_PLAN,
  SHOP_MAX_X,
  SHOP_MAX_Z,
  SHOP_MIN_X,
  SHOP_MIN_Z,
  WINDOW_MAX_X,
  WINDOW_MIN_X,
} from "../zones";
import type { PropContext } from "./context";
import { chamferedSlab, makeRandom } from "./geometry";

/**
 * Floor scatter: the sweepings of a shop nobody has swept.
 *
 * At giant scale the floor is a landscape rather than a surface, and a bare one
 * gives the eye nothing to measure a body against. These are dressing and
 * nothing else — a scrap of paper is not hideable, not accusable, and not an
 * obstacle — so none of it reaches `placements.ts`, the object registry or the
 * navigation blockers. `dressing.test.ts` holds that line.
 *
 * The scatter is laid out here as plain data, without a graphics device, for
 * two reasons: the map has to build identically on every client, and the
 * placement rules (on walkable floor, clear of every prop) are worth checking
 * without a renderer.
 *
 * Cost is bounded by construction. Every piece of a kind shares one geometry
 * and one material, so the whole scatter is one instanced draw call per kind
 * whatever the piece count; per-copy variety rides the tint the batcher already
 * writes into instance colours rather than on extra materials.
 */

export type ClutterKind = "paper_scrap" | "coin" | "button" | "twine" | "dust_clump" | "wood_shaving";

export interface ClutterPiece {
  readonly kind: ClutterKind;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  /** Small tilt off the floor plane, so flat pieces are not invisible edge-on. */
  readonly tilt: readonly [number, number];
  readonly scale: number;
}

interface ClutterKindSpec {
  readonly kind: ClutterKind;
  /** Share of the draw, relative to the other kinds. */
  readonly weight: number;
  readonly materialId: string;
  /** Height of the piece's origin above the floor when it is lying at rest. */
  readonly restY: number;
  /** Largest random tilt, in radians. */
  readonly tilt: number;
  /** How many extra pieces may land beside this one. Litter arrives in twos. */
  readonly cluster: number;
  /** Scales the tint spread the material declares. */
  readonly tint: number;
}

/**
 * The kinds, and the swatches they are made of. Every material is one the map
 * already publishes, so the scatter adds no material to the library and a
 * player who samples a coin gets tarnished brass exactly as they would off a
 * lamp collar.
 */
const CLUTTER_KINDS: readonly ClutterKindSpec[] = [
  { kind: "paper_scrap", weight: 0.24, materialId: "paper_aged_01", restY: 0.0009, tilt: 0.14, cluster: 2, tint: 1 },
  { kind: "dust_clump", weight: 0.22, materialId: "slate_grey_02", restY: 0.003, tilt: 0.3, cluster: 3, tint: 1.4 },
  { kind: "wood_shaving", weight: 0.2, materialId: "oak_pale_03", restY: 0.0008, tilt: 0.26, cluster: 2, tint: 1.2 },
  { kind: "twine", weight: 0.14, materialId: "paper_kraft_02", restY: 0.0019, tilt: 0.06, cluster: 0, tint: 1 },
  { kind: "coin", weight: 0.12, materialId: "brass_aged_02", restY: 0.0009, tilt: 0.04, cluster: 0, tint: 0.6 },
  { kind: "button", weight: 0.08, materialId: "bakelite_black_01", restY: 0.0012, tilt: 0.05, cluster: 0, tint: 1.5 },
];

/**
 * How many points the scatter tries. Rejection thins it and clustering thickens
 * it again, landing near one piece per 0.7 m² of walkable floor — about every
 * two body lengths at this scale, which dresses the floor and gives the eye
 * something to judge distance by without reading as a rubbish tip.
 */
const SCATTER_ATTEMPTS = 180;
const SCATTER_SEED = 5171;
/** How far a piece keeps off a prop's footprint, and off a satellite's parent. */
const PROP_CLEARANCE = 0.07;
const CLUSTER_SPREAD = 0.14;
/** A prop this low is standing on the floor and the scatter goes around it. */
const FLOOR_PROP_MAX_Y = 0.06;

/**
 * Shell footprints the scatter avoids. These are built by `architecture.ts`
 * rather than authored as placements, so nothing else knows they are there.
 */
const SHELL_FOOTPRINTS: readonly { readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number }[] = [
  // The window display platform, which stands 0.34 m proud of the floor.
  { minX: WINDOW_MIN_X, minZ: SHOP_MIN_Z + 0.1, maxX: WINDOW_MAX_X, maxZ: SHOP_MIN_Z + 1.0 },
];

interface Footprint {
  readonly x: number;
  readonly z: number;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly rotationY: number;
}

/**
 * Footprints of every prop standing on the floor, in the prop's own frame so a
 * rotated cabinet is tested as the rectangle it is rather than as the axis
 * aligned box that would swallow the aisle beside it.
 */
const FLOOR_PROPS: readonly Footprint[] = SHOP_PLACEMENTS.filter(
  (placement) => placement.position[1] < FLOOR_PROP_MAX_Y,
).map((placement) => ({
  x: placement.position[0],
  z: placement.position[2],
  halfWidth: placement.focus[0] / 2,
  halfDepth: placement.focus[2] / 2,
  rotationY: placement.rotationY,
}));

function onWalkableFloor(x: number, z: number): boolean {
  return FLOOR_PLAN.some((box) => x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z);
}

function insideProp(x: number, z: number): boolean {
  for (const prop of FLOOR_PROPS) {
    const dx = x - prop.x;
    const dz = z - prop.z;
    const cos = Math.cos(-prop.rotationY);
    const sin = Math.sin(-prop.rotationY);
    const localX = dx * cos - dz * sin;
    const localZ = dx * sin + dz * cos;
    if (
      Math.abs(localX) <= prop.halfWidth + PROP_CLEARANCE &&
      Math.abs(localZ) <= prop.halfDepth + PROP_CLEARANCE
    ) {
      return true;
    }
  }
  return false;
}

function insideShell(x: number, z: number): boolean {
  if (SHELL_FOOTPRINTS.some((box) => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ)) {
    return true;
  }
  return CABINET_BLOCKS.some((box) => x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z);
}

/**
 * Blockers that reach the floor, which is the authored record of where
 * something solid stands.
 *
 * The focus boxes tested above are what the Inspector's reticle brackets and
 * are routinely tighter than the prop, so on their own they let debris land
 * inside a workbench leg. A blocker that starts above the floor is deliberately
 * ignored: the space under a shelf is a hall at this scale and litter belongs
 * in it.
 */
const GROUND_BLOCKERS = NAV_BLOCKERS.filter((blocker) => blocker.min.y <= 0.02 && blocker.max.y >= 0.02);

function insideBlocker(x: number, z: number): boolean {
  return GROUND_BLOCKERS.some(
    (blocker) =>
      x >= blocker.min.x - PROP_CLEARANCE &&
      x <= blocker.max.x + PROP_CLEARANCE &&
      z >= blocker.min.z - PROP_CLEARANCE &&
      z <= blocker.max.z + PROP_CLEARANCE,
  );
}

/** True where a piece of debris may lie: walkable floor, clear of everything. */
function acceptsClutter(x: number, z: number): boolean {
  return onWalkableFloor(x, z) && !insideProp(x, z) && !insideShell(x, z) && !insideBlocker(x, z);
}

const KIND_WEIGHT_TOTAL = CLUTTER_KINDS.reduce((sum, spec) => sum + spec.weight, 0);

function pickKind(roll: number): ClutterKindSpec {
  let cursor = roll * KIND_WEIGHT_TOTAL;
  for (const spec of CLUTTER_KINDS) {
    cursor -= spec.weight;
    if (cursor <= 0) {
      return spec;
    }
  }
  return CLUTTER_KINDS[CLUTTER_KINDS.length - 1] as ClutterKindSpec;
}

function scatter(): readonly ClutterPiece[] {
  const random = makeRandom(SCATTER_SEED);
  const pieces: ClutterPiece[] = [];

  const place = (spec: ClutterKindSpec, x: number, z: number): void => {
    pieces.push({
      kind: spec.kind,
      position: [x, spec.restY, z],
      rotationY: random() * Math.PI * 2,
      tilt: [(random() - 0.5) * 2 * spec.tilt, (random() - 0.5) * 2 * spec.tilt],
      scale: 0.72 + random() * 0.62,
    });
  };

  for (let attempt = 0; attempt < SCATTER_ATTEMPTS; attempt += 1) {
    const x = SHOP_MIN_X + random() * (SHOP_MAX_X - SHOP_MIN_X);
    const z = SHOP_MIN_Z + random() * (SHOP_MAX_Z - SHOP_MIN_Z);
    if (!acceptsClutter(x, z)) {
      continue;
    }

    const spec = pickKind(random());
    place(spec, x, z);

    // Litter arrives in twos. A satellite that lands on a prop is dropped
    // rather than nudged, because nudging is how debris ends up in a wall.
    const satellites = Math.floor(random() * (spec.cluster + 1));
    for (let i = 0; i < satellites; i += 1) {
      const sx = x + (random() - 0.5) * 2 * CLUSTER_SPREAD;
      const sz = z + (random() - 0.5) * 2 * CLUSTER_SPREAD;
      if (acceptsClutter(sx, sz)) {
        place(spec, sx, sz);
      }
    }
  }

  return pieces;
}

/** The scatter, resolved once. Deterministic, so every client lays it out alike. */
export const FLOOR_CLUTTER: readonly ClutterPiece[] = scatter();

const GEOMETRY_BUILDERS: Readonly<Record<ClutterKind, () => THREE.BufferGeometry>> = {
  // A torn corner of a wrapping sheet or a price ticket.
  paper_scrap: () => chamferedSlab(0.075, 0.0012, 0.052, 0.0004),
  // A dropped coin. A cylinder stands on its own axis, so it lies face up.
  coin: () => new THREE.CylinderGeometry(0.0115, 0.0115, 0.0016, 14),
  // A shirt button off something in the textile crates.
  button: () => new THREE.CylinderGeometry(0.0075, 0.0075, 0.0022, 10),
  // A curl of parcel string, still holding the shape of the knot.
  twine: () => {
    const geometry = new THREE.TorusGeometry(0.03, 0.0016, 4, 9, Math.PI * 1.35);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  },
  // Swept-up dust that never made it to the pan.
  dust_clump: () => {
    const geometry = new THREE.IcosahedronGeometry(0.019, 0);
    geometry.scale(1, 0.32, 0.85);
    return geometry;
  },
  // A plane shaving from the workbench, walked out into the shop.
  wood_shaving: () => chamferedSlab(0.062, 0.0011, 0.012, 0.0003),
};

/**
 * Realises the scatter into the background layer.
 *
 * The background layer is the one the quality tier sheds: `CuriosityShop`
 * hides it below `clutterDensity` 0.4, so the weakest tier pays nothing for
 * dressing while every tier that can afford it gets the same floor. Nothing in
 * this layer is accusable, which is what makes dropping it safe.
 */
export function buildFloorClutter(ctx: PropContext): void {
  const b = ctx.batcher;
  const specs = new Map<ClutterKind, ClutterKindSpec>(CLUTTER_KINDS.map((spec) => [spec.kind, spec]));

  b.begin("shop.clutter", [0, 0, 0], 0, false, 1, "background", false);
  for (const piece of FLOOR_CLUTTER) {
    const spec = specs.get(piece.kind);
    if (spec === undefined) {
      continue;
    }
    b.part(
      ctx.geometry.get(`clutter.${piece.kind}`, GEOMETRY_BUILDERS[piece.kind]),
      ctx.materials.get(spec.materialId),
      {
        x: piece.position[0],
        y: piece.position[1],
        z: piece.position[2],
        rx: piece.tilt[0],
        ry: piece.rotationY,
        rz: piece.tilt[1],
        sx: piece.scale,
        sy: piece.scale,
        sz: piece.scale,
      },
      // Debris neither casts nor is worth a shadow-map lookup of its own; it
      // reads off the floor's own shading.
      { shadow: false, receive: true, tint: spec.tint },
    );
  }
  b.end();
}
