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

/** Ids are sequential per disguise, so a list reads Cube 1, Cube 2 in order. */
export function nextShapeId(shapes: readonly ShapeState[]): string {
  let highest = 0;
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
  materialSlotId: string,
): ShapeEdit | null {
  if (shapes.length >= MAX_SHAPES) return null;
  const shape = createShape(nextShapeId(shapes), profileId, bone, materialSlotId);
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
): ShapeEdit | null {
  if (shapes.length >= MAX_SHAPES) return null;
  const source = shapes.find((shape) => shape.id === id);
  if (source === undefined) return null;
  const copy = duplicateShape(source, nextShapeId(shapes));
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
