import * as THREE from "three/webgpu";

import type { ShapeProfileId } from "@foldseek/shared";

import type { PanelProfileId } from "../panels";
import type { SegmentProfileId } from "../segmentForm";

/**
 * Unit-space shell geometry for the Mimic (bible §7.11, §24.8).
 *
 * Every segment profile is a loft of superelliptic cross-sections along +Y: x
 * and z span -0.5..0.5 and y spans 0..1, so a shell is placed by scaling to
 * (width, length, depth) in the bone's own frame and rotating +Y onto the bone
 * axis. No profile has a sharp edge: the cross-section is a superellipse and
 * both ends carry a filleted cap, which is what gives the art direction (§17.1)
 * its bevel highlight.
 *
 * Every profile shares one ring layout, so a form edit rewrites the vertex data
 * of an existing geometry instead of allocating a new one.
 */

export const SHELL_RADIAL_SEGMENTS = 20;

/** Rings across each end fillet and across the straight middle. */
const CAP_RINGS = 4;
const MID_RINGS = 6;

/** The tip cap shares its first ring with the last middle ring. */
const RING_COUNT = CAP_RINGS + MID_RINGS + (CAP_RINGS - 1);
const COLUMN_COUNT = SHELL_RADIAL_SEGMENTS + 1;
const SHELL_VERTEX_COUNT = RING_COUNT * COLUMN_COUNT + 2;

const POLE_START_INDEX = RING_COUNT * COLUMN_COUNT;
const POLE_END_INDEX = POLE_START_INDEX + 1;

/** Half-extent of the unit cross-section at full width. */
const HALF = 0.5;

interface ProfileSpec {
  /** Superellipse exponent at roundness 0 and 1. Two is an ellipse; higher approaches a rounded rectangle. */
  readonly exponentCrisp: number;
  readonly exponentSoft: number;
  /** Fraction of the length taken by each end fillet, at roundness 0 and 1. */
  readonly capCrisp: number;
  readonly capSoft: number;
  /** Cross-section width at the tip, relative to the base. */
  readonly tipRadius: number;
  /** Depth relative to width, at the base and at the tip. */
  readonly baseDepth: number;
  readonly tipDepth: number;
  /**
   * Shifts each section so the face on the +z side stays flat while the section
   * shrinks. This is what makes the wedge read as a foot rather than a spindle.
   */
  readonly flatBack: boolean;
}

const PROFILE_SPECS: Readonly<Record<SegmentProfileId, ProfileSpec>> = {
  capsule: {
    exponentCrisp: 2.6,
    exponentSoft: 2,
    // A capsule's caps used to take nine tenths of a limb between them at the
    // middle of the roundness slider, so an arm was a lemon with no straight
    // section at all and read as a bead rather than as a limb. These leave a
    // straight shaft either way and still round off to a dome at roundness 1.
    capCrisp: 0.12,
    capSoft: 0.32,
    tipRadius: 1,
    baseDepth: 1,
    tipDepth: 1,
    flatBack: false,
  },
  rounded_box: {
    exponentCrisp: 7,
    exponentSoft: 3.2,
    capCrisp: 0.05,
    capSoft: 0.17,
    tipRadius: 1,
    baseDepth: 1,
    tipDepth: 1,
    flatBack: false,
  },
  flat_panel: {
    exponentCrisp: 8,
    exponentSoft: 3.5,
    capCrisp: 0.04,
    capSoft: 0.13,
    tipRadius: 1,
    baseDepth: 1,
    tipDepth: 1,
    flatBack: false,
  },
  tapered_block: {
    exponentCrisp: 6.5,
    exponentSoft: 3,
    capCrisp: 0.05,
    capSoft: 0.15,
    tipRadius: 0.68,
    baseDepth: 1,
    tipDepth: 1,
    flatBack: false,
  },
  cylinder: {
    exponentCrisp: 2,
    exponentSoft: 2,
    capCrisp: 0.05,
    capSoft: 0.17,
    tipRadius: 1,
    baseDepth: 1,
    tipDepth: 1,
    flatBack: false,
  },
  cone_frustum: {
    exponentCrisp: 2,
    exponentSoft: 2,
    capCrisp: 0.05,
    capSoft: 0.14,
    tipRadius: 0.5,
    baseDepth: 1,
    tipDepth: 1,
    flatBack: false,
  },
  soft_wedge: {
    exponentCrisp: 6,
    exponentSoft: 2.8,
    capCrisp: 0.05,
    capSoft: 0.14,
    tipRadius: 1,
    baseDepth: 1,
    tipDepth: 0.5,
    flatBack: true,
  },
};

export interface ShellShapeOptions {
  readonly profileId: SegmentProfileId;
  /** 0..1 edge softness. */
  readonly roundness: number;
  /** Cross-section multiplier at the tip, from the segment's taper parameter. */
  readonly tipScale: number;
  /** Total twist about the bone axis across the segment, in radians. */
  readonly twistRad: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Ring heights and the cap falloff at each height, shared by every profile. */
function fillRingLayout(startCap: number, endCap: number, heights: Float64Array, falloff: Float64Array): void {
  let index = 0;
  for (let i = 1; i <= CAP_RINGS; i++) {
    const angle = (i / CAP_RINGS) * (Math.PI / 2);
    heights[index] = startCap * (1 - Math.cos(angle));
    falloff[index] = Math.sin(angle);
    index += 1;
  }
  const middleSpan = 1 - startCap - endCap;
  for (let j = 1; j <= MID_RINGS; j++) {
    heights[index] = startCap + middleSpan * (j / MID_RINGS);
    falloff[index] = 1;
    index += 1;
  }
  for (let i = CAP_RINGS - 1; i >= 1; i--) {
    const angle = (i / CAP_RINGS) * (Math.PI / 2);
    heights[index] = 1 - endCap * (1 - Math.cos(angle));
    falloff[index] = Math.sin(angle);
    index += 1;
  }
}

/** Superellipse coordinate: `sign(c) * |c| ** (2 / exponent)`. */
function superellipse(value: number, exponent: number): number {
  const magnitude = Math.pow(Math.abs(value), 2 / exponent);
  return value < 0 ? -magnitude : magnitude;
}

const ringHeights = new Float64Array(RING_COUNT);
const ringFalloff = new Float64Array(RING_COUNT);

/**
 * Rewrites a shell geometry in place. The ring layout never changes, so the
 * attribute buffers and the index are allocated once by
 * `createSegmentShellGeometry` and only their contents are replaced.
 */
export function writeSegmentShell(geometry: THREE.BufferGeometry, options: ShellShapeOptions): void {
  const spec = PROFILE_SPECS[options.profileId];
  const roundness = clamp01(options.roundness);
  const exponent = lerp(spec.exponentCrisp, spec.exponentSoft, roundness);
  const cap = lerp(spec.capCrisp, spec.capSoft, roundness);
  // Two caps must leave a middle section behind, whatever the roundness.
  const capLength = Math.min(cap, 0.45);

  fillRingLayout(capLength, capLength, ringHeights, ringFalloff);

  const positionAttribute = geometry.getAttribute("position") as THREE.BufferAttribute;
  const uvAttribute = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const positions = positionAttribute.array as Float32Array;
  const uvs = uvAttribute.array as Float32Array;

  const tipScale = Number.isFinite(options.tipScale) ? options.tipScale : 1;
  const twist = Number.isFinite(options.twistRad) ? options.twistRad : 0;

  for (let ring = 0; ring < RING_COUNT; ring++) {
    const t = ringHeights[ring] ?? 0;
    const falloff = ringFalloff[ring] ?? 1;
    const taper = lerp(1, tipScale, t) * falloff;
    const halfX = HALF * lerp(1, spec.tipRadius, t) * taper;
    const depthRatio = lerp(spec.baseDepth, spec.tipDepth, t);
    const halfZ = HALF * lerp(1, spec.tipRadius, t) * depthRatio * taper;
    // Keeping the +z face flat means shifting the section by exactly what the
    // depth lost, so a wedge stands on a flat sole rather than a knife edge.
    const offsetZ = spec.flatBack ? HALF * (spec.baseDepth - depthRatio) * lerp(1, tipScale, t) : 0;
    const angle = twist * t;
    const cosTwist = Math.cos(angle);
    const sinTwist = Math.sin(angle);

    for (let column = 0; column < COLUMN_COUNT; column++) {
      const phi = (column / SHELL_RADIAL_SEGMENTS) * Math.PI * 2;
      const rawX = superellipse(Math.cos(phi), exponent) * halfX;
      const rawZ = superellipse(Math.sin(phi), exponent) * halfZ + offsetZ;
      const vertex = ring * COLUMN_COUNT + column;
      positions[vertex * 3] = rawX * cosTwist + rawZ * sinTwist;
      positions[vertex * 3 + 1] = t;
      positions[vertex * 3 + 2] = rawZ * cosTwist - rawX * sinTwist;
      uvs[vertex * 2] = column / SHELL_RADIAL_SEGMENTS;
      uvs[vertex * 2 + 1] = t;
    }
  }

  // The start section is never shifted: `offsetZ` is zero at t = 0 by definition.
  positions[POLE_START_INDEX * 3] = 0;
  positions[POLE_START_INDEX * 3 + 1] = 0;
  positions[POLE_START_INDEX * 3 + 2] = 0;
  uvs[POLE_START_INDEX * 2] = 0.5;
  uvs[POLE_START_INDEX * 2 + 1] = 0;

  const endOffsetZ = spec.flatBack ? HALF * (spec.baseDepth - spec.tipDepth) * tipScale : 0;
  positions[POLE_END_INDEX * 3] = endOffsetZ * Math.sin(twist);
  positions[POLE_END_INDEX * 3 + 1] = 1;
  positions[POLE_END_INDEX * 3 + 2] = endOffsetZ * Math.cos(twist);
  uvs[POLE_END_INDEX * 2] = 0.5;
  uvs[POLE_END_INDEX * 2 + 1] = 1;

  positionAttribute.needsUpdate = true;
  uvAttribute.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
}

/** Allocates an empty shell with the shared ring topology already indexed. */
export function createSegmentShellGeometry(options: ShellShapeOptions): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SHELL_VERTEX_COUNT * 3), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(SHELL_VERTEX_COUNT * 3), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(SHELL_VERTEX_COUNT * 2), 2));

  const indices: number[] = [];
  for (let column = 0; column < SHELL_RADIAL_SEGMENTS; column++) {
    indices.push(POLE_START_INDEX, column, column + 1);
  }
  for (let ring = 0; ring < RING_COUNT - 1; ring++) {
    const lower = ring * COLUMN_COUNT;
    const upper = (ring + 1) * COLUMN_COUNT;
    for (let column = 0; column < SHELL_RADIAL_SEGMENTS; column++) {
      const a = lower + column;
      const b = lower + column + 1;
      const c = upper + column + 1;
      const d = upper + column;
      indices.push(a, c, b, a, d, c);
    }
  }
  const lastRing = (RING_COUNT - 1) * COLUMN_COUNT;
  for (let column = 0; column < SHELL_RADIAL_SEGMENTS; column++) {
    indices.push(POLE_END_INDEX, lastRing + column + 1, lastRing + column);
  }
  geometry.setIndex(indices);

  writeSegmentShell(geometry, options);
  return geometry;
}

/** How far a rib swells past the bellows' nominal profile. */
const BELLOWS_RIB_AMPLITUDE = 0.14;

/**
 * Widest point of a bellows relative to the scale it is built at. The middle rib
 * lands on the widest part of the profile, so a bellows scaled to a diameter is
 * this much fatter than that diameter at its equator. Whether the rubber stands
 * proud of the shells it bridges is decided here, so callers sizing a joint work
 * in outer diameter and divide it back out.
 */
export const BELLOWS_OUTER_RATIO = 1 + BELLOWS_RIB_AMPLITUDE;

/**
 * Dark rubber bellows for a joint (§24.3). A ribbed ball centred on the joint
 * fills the gap between two shells at every legal bend because it is
 * rotationally symmetric about the joint: no bend angle can expose a seam it
 * does not already cover. Unit diameter, centred on the origin.
 */
export function createBellowsGeometry(ribs: number): THREE.BufferGeometry {
  const rings = 22;
  const radial = 16;
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const angle = t * Math.PI;
    const profile = Math.sin(angle);
    const rib = 1 - BELLOWS_RIB_AMPLITUDE * Math.cos(t * ribs * Math.PI * 2);
    points.push(new THREE.Vector2(Math.max(profile * rib * 0.5, 0), -0.5 + t));
  }
  const geometry = new THREE.LatheGeometry(points, radial);
  geometry.computeVertexNormals();
  return geometry;
}

function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const r = Math.max(Math.min(radius, halfWidth * 0.98, halfHeight * 0.98), 0.0005);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + r, -halfHeight);
  shape.lineTo(halfWidth - r, -halfHeight);
  shape.absarc(halfWidth - r, -halfHeight + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(halfWidth, halfHeight - r);
  shape.absarc(halfWidth - r, halfHeight - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-halfWidth + r, halfHeight);
  shape.absarc(-halfWidth + r, halfHeight - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-halfWidth, -halfHeight + r);
  shape.absarc(-halfWidth + r, -halfHeight + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

function triangleShape(width: number, height: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const r = Math.max(radius, 0.0005);
  shape.moveTo(-halfWidth + r, -halfHeight);
  shape.lineTo(halfWidth - r, -halfHeight);
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth - r * 0.6, -halfHeight + r);
  shape.lineTo(r * 0.5, halfHeight - r);
  shape.quadraticCurveTo(0, halfHeight, -r * 0.5, halfHeight - r);
  shape.lineTo(-halfWidth + r * 0.6, -halfHeight + r);
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + r, -halfHeight);
  return shape;
}

/**
 * Panel plate, one unit across and one unit high in the xy plane with the
 * hinge edge at y = 0, so a panel is placed by scaling to its resolved size.
 */
export function createPanelGeometry(profileId: PanelProfileId, thickness: number): THREE.BufferGeometry {
  const bevel = Math.min(thickness * 0.4, 0.03);
  const shape =
    profileId === "triangle"
      ? triangleShape(1 - 2 * bevel, 1 - 2 * bevel, 0.12)
      : roundedRectShape(1 - 2 * bevel, 1 - 2 * bevel, profileId === "rounded_rect" ? 0.2 : 0.05);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(thickness - 2 * bevel, 0.001),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 5,
    steps: 1,
  });
  // ExtrudeGeometry's own UV generator writes the shape's coordinates, so a
  // unit plate would arrive at roughly -0.5..0.5 and the bevelled rim on a
  // scale of its own. Body painting maps a part's 0..1 square onto its tile of
  // the paint atlas, so the plate publishes that square exactly.
  writePlateUvs(geometry);
  // Hinge edge at the origin, plate growing along +y and centred in z.
  geometry.translate(0, 0.5, -(thickness / 2 - bevel));
  geometry.computeVertexNormals();
  return geometry;
}

/** Maps the plate's own xy extent, bevel included, onto the unit UV square. */
function writePlateUvs(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (box === null) {
    return;
  }
  const spanX = Math.max(box.max.x - box.min.x, 1e-6);
  const spanY = Math.max(box.max.y - box.min.y, 1e-6);
  const uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    uvs[i * 2] = (position.getX(i) - box.min.x) / spanX;
    uvs[i * 2 + 1] = (position.getY(i) - box.min.y) / spanY;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

/** Rounded puck used for the pose handles and the eye shutter. */
export function createPuckGeometry(radius: number, thickness: number): THREE.BufferGeometry {
  const points: THREE.Vector2[] = [];
  const fillet = Math.min(thickness / 2, radius * 0.6);
  const steps = 5;
  points.push(new THREE.Vector2(0, -thickness / 2));
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * (Math.PI / 2);
    points.push(
      new THREE.Vector2(
        radius - fillet + Math.sin(angle) * fillet,
        -thickness / 2 + fillet - Math.cos(angle) * fillet,
      ),
    );
  }
  for (let i = steps; i >= 0; i--) {
    const angle = (i / steps) * (Math.PI / 2);
    points.push(
      new THREE.Vector2(
        radius - fillet + Math.sin(angle) * fillet,
        thickness / 2 - fillet + Math.cos(angle) * fillet,
      ),
    );
  }
  points.push(new THREE.Vector2(0, thickness / 2));
  const geometry = new THREE.LatheGeometry(points, 24);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The solid a shape profile draws.
 *
 * Unit-sized and centred, because a shape carries its own scale: geometry is
 * built once per profile and shared by every instance, so an edit moves a
 * transform rather than rewriting vertices. A Forge that rebuilt geometry on
 * every drag would hitch on every press.
 *
 * Segment counts are deliberately low. Six players carry up to sixteen of
 * these each, and a disguise is read at a distance as a silhouette, where a
 * cylinder's facet count is invisible and its draw cost is not.
 */
/**
 * The solid a drawn outline becomes.
 *
 * The player's own sweep, closed and given thickness. One mesh, not an
 * approximation assembled from boxes: what they drew is what stands in the
 * room, which is the whole promise of drawing it.
 */
export function createDrawnGeometry(
  outline: readonly (readonly [number, number])[],
  /**
   * Fill the outline, or follow it as a ribbon.
   *
   * Filling closes the stroke into a solid slab, which reads as an object but
   * invents surface the player never drew - two ends of a C become a closed
   * crescent. A ribbon follows the line itself and adds nothing, so what
   * stands in the room is exactly the gesture that was made.
   */
  filled = true,
): THREE.BufferGeometry {
  if (outline.length < 3) return new THREE.BoxGeometry(1, 1, 1);
  if (!filled) return withBoxUvs(createRibbonGeometry(outline));
  const path = new THREE.Shape();
  const [first, ...rest] = outline;
  path.moveTo(first?.[0] ?? 0, first?.[1] ?? 0);
  for (const point of rest) path.lineTo(point[0], point[1]);
  path.closePath();
  const geometry = new THREE.ExtrudeGeometry(path, {
    depth: 1,
    bevelEnabled: false,
    curveSegments: 4,
  });
  // Centred, because a shape carries its own position and a geometry with its
  // own offset would fight the gizmo that moves it.
  geometry.center();
  return withBoxUvs(geometry);
}

/**
 * Rewrites a geometry's UVs as a box projection over its own bounds.
 *
 * ExtrudeGeometry takes the front and back faces' UVs straight from the
 * the shape's own coordinates, which after centring run about -0.5 to +0.5.
 * Everything negative falls outside the paint atlas tile, so a brush landed on
 * roughly half the solid and the rest stayed bare.
 */
function withBoxUvs(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.center();
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (bounds === null || position === undefined) return geometry;

  const spanX = Math.max(bounds.max.x - bounds.min.x, 1e-6);
  const spanY = Math.max(bounds.max.y - bounds.min.y, 1e-6);
  const spanZ = Math.max(bounds.max.z - bounds.min.z, 1e-6);
  const uv = new Float32Array(position.count * 2);

  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    // The plane a face actually faces. Projecting everything on X and Y gave
    // the extruded SIDE walls the same coordinate front to back - a zero-area
    // patch of texture stretched along the whole wall, which is what the white
    // streaks were. Each face is mapped on the two axes it spans instead.
    const nx = Math.abs(normal?.getX(index) ?? 0);
    const ny = Math.abs(normal?.getY(index) ?? 0);
    const nz = Math.abs(normal?.getZ(index) ?? 1);
    let u: number;
    let v: number;
    if (nz >= nx && nz >= ny) {
      u = (x - bounds.min.x) / spanX;
      v = (y - bounds.min.y) / spanY;
    } else if (nx >= ny) {
      u = (z - bounds.min.z) / spanZ;
      v = (y - bounds.min.y) / spanY;
    } else {
      u = (x - bounds.min.x) / spanX;
      v = (z - bounds.min.z) / spanZ;
    }
    uv[index * 2] = u;
    uv[index * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}


export function createShapeGeometry(profileId: ShapeProfileId): THREE.BufferGeometry {
  switch (profileId) {
    case "cylinder":
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
    case "sphere":
      return new THREE.SphereGeometry(0.5, 16, 12);
    case "wedge": {
      // A box with one edge collapsed: the roof, lid and ramp form that a cube
      // and a cylinder together cannot make.
      const wedge = new THREE.BufferGeometry();
      const h = 0.5;
      wedge.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
        -h, -h, -h, h, -h, -h, h, -h, h,
        -h, -h, -h, h, -h, h, -h, -h, h,
        -h, h, -h, h, h, -h, h, -h, h,
        -h, h, -h, h, -h, h, -h, -h, h,
        -h, -h, -h, -h, h, -h, h, h, -h,
        -h, -h, -h, h, h, -h, h, -h, -h,
        h, -h, -h, h, h, -h, h, -h, h,
        -h, -h, h, h, -h, h, -h, h, -h,
      ]), 3));
      wedge.computeVertexNormals();
      return wedge;
    }
    case "plane":
      // A thin slab rather than a true plane: a disguise is seen from every
      // angle, and a one-sided face vanishes from behind.
      return new THREE.BoxGeometry(1, 1, 0.02);
    case "cube":
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

/** How wide a ribbon stands, as a share of the drawing's own span. */
const RIBBON_WIDTH = 0.12;

/**
 * The stroke itself, given width and depth, with nothing added between its
 * ends.
 *
 * Every segment becomes a slab along the line, so a C stays a C. What the
 * player drew is all that stands up.
 */
function createRibbonGeometry(
  outline: readonly (readonly [number, number])[],
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let index = 1; index < outline.length; index += 1) {
    const from = outline[index - 1];
    const to = outline[index];
    if (from === undefined || to === undefined) continue;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const segment = new THREE.BoxGeometry(length + RIBBON_WIDTH, RIBBON_WIDTH, 1);
    segment.rotateZ(Math.atan2(dy, dx));
    segment.translate((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 0);
    parts.push(segment);
  }
  if (parts.length === 0) return new THREE.BoxGeometry(1, 1, 1);

  // Merged by hand rather than by a helper, because the client bundles no
  // BufferGeometryUtils and a ribbon is only ever a few dozen boxes.
  let vertices = 0;
  for (const part of parts) vertices += part.getAttribute("position").count;
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const indices: number[] = [];
  let offset = 0;
  for (const part of parts) {
    const partPosition = part.getAttribute("position");
    const partNormal = part.getAttribute("normal");
    const partIndex = part.getIndex();
    for (let i = 0; i < partPosition.count; i += 1) {
      position[(offset + i) * 3] = partPosition.getX(i);
      position[(offset + i) * 3 + 1] = partPosition.getY(i);
      position[(offset + i) * 3 + 2] = partPosition.getZ(i);
      normal[(offset + i) * 3] = partNormal?.getX(i) ?? 0;
      normal[(offset + i) * 3 + 1] = partNormal?.getY(i) ?? 0;
      normal[(offset + i) * 3 + 2] = partNormal?.getZ(i) ?? 1;
    }
    if (partIndex !== null) {
      for (let i = 0; i < partIndex.count; i += 1) indices.push(offset + partIndex.getX(i));
    }
    offset += partPosition.count;
    part.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setIndex(indices);
  return geometry;
}
