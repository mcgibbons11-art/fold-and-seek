import { MAX_SHAPES, type ShapeProfileId } from "@foldseek/shared";

import { createShape, duplicateShape, type ShapeState } from "../mimic/shapes";
import type { BoneName } from "../mimic/rig";

/**
 * Building a disguise out of primitives.
 *
 * These are pure list operations over a disguise's shapes, kept away from the
 * controller so the rules can be read and tested without a scene, a canvas or
 * a renderer. Each returns a new list, or null when the edit is refused, so
 * the caller can turn an accepted edit into one undoable command.
 *
 * The list is deliberately ordered: it is what the object panel draws, and a
 * player who adds a rim expects to find it at the end rather than somewhere
 * the sort happened to put it.
 */

export interface ShapeEdit {
  readonly shapes: ShapeState[];
  /** What the caller should leave selected, which is what the gizmo drives. */
  readonly selectedId: string;
}

/**
 * The next unused shape id.
 *
 * `floor` is a high-water mark that never falls, and it is not optional
 * decoration: ids double as material slots and paint tiles, so an id handed
 * out twice gives a fresh shape the previous occupant's colour and strokes.
 * Deleting the highest-numbered shape freed its number for exactly that.
 */
export function nextShapeId(shapes: readonly ShapeState[], floor = 0): string {
  let highest = floor;
  for (const shape of shapes) {
    const match = /^shape_(\d+)$/.exec(shape.id);
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
  }
  return `shape_${String(highest + 1).padStart(4, "0")}`;
}

/**
 * The name the object panel shows: the profile, numbered per profile.
 *
 * Numbering per profile rather than across the whole list is what makes a
 * panel readable at a glance - "Cylinder 2" says what it is and which one,
 * where "Shape 7" says neither.
 */
export function shapeLabels(shapes: readonly ShapeState[]): Map<string, string> {
  const counts = new Map<ShapeProfileId, number>();
  const labels = new Map<string, string>();
  for (const shape of shapes) {
    const seen = (counts.get(shape.profileId) ?? 0) + 1;
    counts.set(shape.profileId, seen);
    const name = shape.profileId.charAt(0).toUpperCase() + shape.profileId.slice(1);
    labels.set(shape.id, `${name} ${String(seen)}`);
  }
  return labels;
}

export function addShape(
  shapes: readonly ShapeState[],
  profileId: ShapeProfileId,
  bone: BoneName,
  materialSlotId?: string,
  floor = 0,
): ShapeEdit | null {
  if (shapes.length >= MAX_SHAPES) return null;
  const id = nextShapeId(shapes, floor);
  // A slot of its own, so a jar can have a darker rim. Nothing is assigned to
  // it until the player paints it, and an unassigned slot falls back to the
  // body's finish, so the default look is unchanged.
  const shape = createShape(id, profileId, bone, materialSlotId ?? id);
  return { shapes: [...shapes, shape], selectedId: shape.id };
}

/**
 * Copies a shape, which is the verb that makes building fast: barrel bands, a
 * pot's rim, a row of legs. The copy lands beside its original rather than
 * inside it, or the press would look like it did nothing.
 */
export function duplicateShapeById(
  shapes: readonly ShapeState[],
  id: string,
  floor = 0,
): ShapeEdit | null {
  if (shapes.length >= MAX_SHAPES) return null;
  const source = shapes.find((shape) => shape.id === id);
  if (source === undefined) return null;
  const copyId = nextShapeId(shapes, floor);
  const copy = duplicateShape(source, copyId);
  // A copy keeps the finish it was copied from rather than inheriting a fresh
  // empty slot, because "another one of these" means another one that looks
  // like it.
  return { shapes: [...shapes, copy], selectedId: copy.id };
}

/**
 * Removes a shape, and hands back whatever should be selected in its place -
 * the neighbour, so a player deleting a run of shapes keeps pressing one key
 * rather than reselecting between every press.
 */
export function removeShapeById(
  shapes: readonly ShapeState[],
  id: string,
): ShapeEdit | null {
  const index = shapes.findIndex((shape) => shape.id === id);
  if (index < 0) return null;
  const next = shapes.filter((shape) => shape.id !== id);
  const neighbour = next[Math.min(index, next.length - 1)];
  return { shapes: next, selectedId: neighbour?.id ?? "" };
}

/** A point in world space, which is all the fit test needs of a body part. */
export interface FitPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A shape's world box, as the renderer places it. */
export interface FitBox {
  readonly min: FitPoint;
  readonly max: FitPoint;
}

/**
 * How much of the body is hidden inside what the player built.
 *
 * This is the rule that keeps folding central. A disguise is not the shapes
 * alone: it is the shapes WITH the body tucked inside them, and a creature
 * standing beside a beautifully built barrel is still a creature. Scoring the
 * tuck makes the fold worth doing rather than decorative, and gives a player
 * something to chase while they work.
 *
 * Deliberately a fraction of body parts rather than a volume overlap. It is
 * cheap enough to run every frame, and it answers the question a player is
 * actually asking - "is any of me still sticking out?" - in the units they
 * can act on, which is limbs.
 */
export function fitScore(parts: readonly FitPoint[], boxes: readonly FitBox[]): number {
  if (parts.length === 0) return 0;
  if (boxes.length === 0) return 0;
  let inside = 0;
  for (const part of parts) {
    for (const box of boxes) {
      if (
        part.x >= box.min.x &&
        part.x <= box.max.x &&
        part.y >= box.min.y &&
        part.y <= box.max.y &&
        part.z >= box.min.z &&
        part.z <= box.max.z
      ) {
        inside += 1;
        break;
      }
    }
  }
  return inside / parts.length;
}

/**
 * Where a shape has to move to sit flush against its nearest neighbour.
 *
 * Built shapes float. A barrel's two bands end up nearly touching, a lid ends
 * up nearly on its jar, and "nearly" is what a hider gets shot for: a gap of a
 * few millimetres at this scale reads as two objects rather than one, which is
 * exactly the tell a disguise is trying not to give.
 *
 * Snapping moves along the single axis the two are already closest on, which is
 * the one the player was plainly aiming at. Returns null when there is nothing
 * to snap to, or when they already touch.
 */
/** Closer than this reads as touching, at a scale where the body is 0.35 m. */
const FLUSH_TOLERANCE_M = 1e-4;

export function snapOffset(
  moving: FitBox,
  others: readonly FitBox[],
): { readonly axis: 0 | 1 | 2; readonly delta: number } | null {
  let best: { axis: 0 | 1 | 2; delta: number; distance: number } | null = null;

  for (const other of others) {
    const axes: [0 | 1 | 2, number, number, number, number][] = [
      [0, moving.min.x, moving.max.x, other.min.x, other.max.x],
      [1, moving.min.y, moving.max.y, other.min.y, other.max.y],
      [2, moving.min.z, moving.max.z, other.min.z, other.max.z],
    ];
    for (const [axis, lo, hi, otherLo, otherHi] of axes) {
      // Two ways to sit flush: this one's far face on that one's near face,
      // or the reverse. The smaller move is the one that was meant.
      const above = otherHi - lo;
      const below = otherLo - hi;
      const delta = Math.abs(above) <= Math.abs(below) ? above : below;
      const distance = Math.abs(delta);
      // Already touching on this axis means the pair is flush, and moving them
      // on a different axis would slide a seated shape off its neighbour -
      // which is worse than the gap the player asked to close.
      if (distance <= FLUSH_TOLERANCE_M) return null;
      if (best === null || distance < best.distance) best = { axis, delta, distance };
    }
  }

  return best === null ? null : { axis: best.axis, delta: best.delta };
}

/** A point on the drawing plane, in metres. */
export interface DrawPoint {
  readonly x: number;
  readonly y: number;
}

/** One box of a drawn silhouette: centre and size on the drawing plane. */
export interface DrawnBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Turns a drawn outline into the boxes that fill it.
 *
 * The whole point of drawing is that a player says "that shape" once, with one
 * gesture, instead of assembling it from primitives under a clock. So the
 * stroke is rasterised: its bounding box is divided into a coarse grid, every
 * column the stroke passes through is filled from its lowest to its highest
 * point, and each column becomes one box.
 *
 * Columns rather than free-form cells because a silhouette is what a hider is
 * judged on, and a column-filled outline has the same outline as the drawing
 * while costing a fraction of the shapes. Adjacent columns of equal height are
 * merged for the same reason: sixteen is the ceiling, and a drawing that spent
 * them all on one smooth edge would have nothing left for the rest of itself.
 */
export function strokeToBoxes(
  points: readonly DrawPoint[],
  maxBoxes: number,
  minSize: number,
): DrawnBox[] {
  if (points.length < 2 || maxBoxes < 1) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
  }
  const span = maxX - minX;
  if (!Number.isFinite(span) || span < minSize) return [];

  // One column per box allowed, so a drawing never overruns the ceiling.
  const columns = Math.max(1, Math.min(maxBoxes, 12));
  const width = span / columns;
  const lows = new Array<number>(columns).fill(Infinity);
  const highs = new Array<number>(columns).fill(-Infinity);

  for (const point of points) {
    const index = Math.min(columns - 1, Math.max(0, Math.floor((point.x - minX) / width)));
    lows[index] = Math.min(lows[index] ?? Infinity, point.y);
    highs[index] = Math.max(highs[index] ?? -Infinity, point.y);
  }

  const boxes: DrawnBox[] = [];
  for (let index = 0; index < columns; index += 1) {
    const low = lows[index];
    const high = highs[index];
    if (low === undefined || high === undefined || low === Infinity) continue;
    // A stroke that crossed a column at a single height still has to become
    // something visible, so a flat column takes the minimum thickness.
    const height = Math.max(high - low, minSize);
    const previous = boxes.at(-1);
    if (
      previous !== undefined &&
      Math.abs(previous.height - height) < minSize &&
      Math.abs(previous.y - (low + height / 2)) < minSize
    ) {
      // Same height as its neighbour: widen that box rather than spend another.
      boxes[boxes.length - 1] = {
        x: (previous.x - previous.width / 2 + minX + (index + 1) * width) / 2,
        y: previous.y,
        width: minX + (index + 1) * width - (previous.x - previous.width / 2),
        height: previous.height,
      };
      continue;
    }
    boxes.push({
      x: minX + (index + 0.5) * width,
      y: low + height / 2,
      width,
      height,
    });
    if (boxes.length >= maxBoxes) break;
  }
  return boxes;
}
