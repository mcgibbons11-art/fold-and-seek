import { MAX_SHAPES, SHAPE_PROFILE_IDS, type ShapeProfileId } from "@foldseek/shared";

import { BONE_NAMES, type BoneName } from "./rig";

/**
 * The primitives a disguise is built from.
 *
 * A hider's problem is silhouette. Hinged panels made that worse: each one was
 * a flap on a socket, so it radiated out of a joint and read as a limb on a
 * creature. A shape is a solid placed in a bone's own frame, so a jar is two
 * cylinders and a rim, and what the room sees is a made object.
 *
 * Attached, not floating: a shape rides the bone it belongs to, so a
 * construction holds together while its owner creeps instead of shearing off
 * the body. The body is still the point - a disguise is judged on folding to
 * fit INSIDE the silhouette it builds.
 */

export interface ShapeState {
  /** Stable across edits, so an object list and Duplicate have something to name. */
  id: string;
  profileId: ShapeProfileId;
  bone: BoneName;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  materialSlotId: string;
  /** The swept outline, for a drawn solid. Absent on the primitives. */
  outline?: [number, number][];
}

/** Where a new shape appears, in the frame of the bone carrying it. */
const DEFAULT_SHAPE_SCALE: readonly [number, number, number] = [0.35, 0.35, 0.35];

export function createShape(
  id: string,
  profileId: ShapeProfileId,
  bone: BoneName,
  materialSlotId: string,
): ShapeState {
  return {
    id,
    profileId,
    bone,
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [...DEFAULT_SHAPE_SCALE] as [number, number, number],
    materialSlotId,
  };
}

export function cloneShapeState(shape: ShapeState): ShapeState {
  return {
    ...shape,
    ...(shape.outline === undefined
      ? {}
      : { outline: shape.outline.map((point) => [...point] as [number, number]) }),
    position: [...shape.position] as [number, number, number],
    rotation: [...shape.rotation] as [number, number, number, number],
    scale: [...shape.scale] as [number, number, number],
  };
}

/**
 * A copy of a shape, offset so it does not hide inside the one it came from.
 *
 * Duplicate is the verb that makes building fast - barrel bands, pot rims, a
 * row of legs - and a copy landing exactly on its original looks like nothing
 * happened at all.
 */
export function duplicateShape(shape: ShapeState, id: string): ShapeState {
  const copy = cloneShapeState(shape);
  copy.id = id;
  copy.position[0] += shape.scale[0];
  return copy;
}

/** Validation shared by the authoring path and the decoder. */
export function validateShapes(shapes: readonly ShapeState[]): string[] {
  const errors: string[] = [];
  if (shapes.length > MAX_SHAPES) {
    errors.push(`disguise.shapes has ${String(shapes.length)} entries, over the ${String(MAX_SHAPES)} cap`);
  }
  const seen = new Set<string>();
  for (const [index, shape] of shapes.entries()) {
    const at = `disguise.shapes[${String(index)}]`;
    if (seen.has(shape.id)) errors.push(`${at} repeats the id ${shape.id}`);
    seen.add(shape.id);
    if (!(SHAPE_PROFILE_IDS as readonly string[]).includes(shape.profileId)) {
      errors.push(`${at} has an unknown profile ${shape.profileId}`);
    }
    if (!(BONE_NAMES as readonly string[]).includes(shape.bone)) {
      // Attachment is what keeps a construction with its body; a shape on no
      // bone would be left behind the moment its owner moved.
      errors.push(`${at} is attached to an unknown bone ${shape.bone}`);
    }
    if (shape.scale.some((axis) => !Number.isFinite(axis) || axis <= 0)) {
      errors.push(`${at} has a scale that is not positive on every axis`);
    }
  }
  return errors;
}
