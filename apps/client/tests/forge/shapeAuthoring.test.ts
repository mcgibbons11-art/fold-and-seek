import { MAX_SHAPES } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import {
  addShape,
  duplicateShapeById,
  nextShapeId,
  removeShapeById,
  shapeLabels,
} from "../../src/forge/shapeAuthoring";
import { validateShapes, type ShapeState } from "../../src/mimic/shapes";

/**
 * Building a disguise out of primitives, as list rules rather than as a scene.
 *
 * What is worth pinning is the authoring feel: a copy that lands somewhere you
 * can see, a delete that leaves you somewhere sensible, and names a player can
 * read at a glance. Those are the things that decide whether a 115 second
 * Forge is enough time to build a jar.
 */

function build(count: number): ShapeState[] {
  let shapes: ShapeState[] = [];
  for (let index = 0; index < count; index += 1) {
    const edit = addShape(shapes, "cube", "pelvis", "body");
    if (edit === null) throw new Error("the fixture should fit");
    shapes = edit.shapes;
  }
  return shapes;
}

describe("building a disguise out of primitives", () => {
  it("adds a shape, selects it, and keeps the list valid", () => {
    const edit = addShape([], "cylinder", "pelvis", "body");
    expect(edit).not.toBeNull();
    expect(edit?.shapes).toHaveLength(1);
    expect(edit?.selectedId).toBe(edit?.shapes[0]?.id);
    expect(validateShapes(edit?.shapes ?? [])).toEqual([]);
  });

  it("refuses to add past the wire's ceiling rather than silently dropping one", () => {
    expect(addShape(build(MAX_SHAPES), "cube", "pelvis", "body")).toBeNull();
  });

  it("lands a duplicate beside its original, not inside it", () => {
    const shapes = build(1);
    const source = shapes[0];
    if (source === undefined) throw new Error("fixture");
    const edit = duplicateShapeById(shapes, source.id);
    const copy = edit?.shapes.at(-1);
    expect(copy).toBeDefined();
    // A copy on top of its original looks exactly like nothing happened.
    expect(copy?.position).not.toEqual(source.position);
    expect(copy?.profileId).toBe(source.profileId);
    expect(edit?.selectedId).toBe(copy?.id);
  });

  it("never reuses an id, even after deletions", () => {
    const shapes = build(3);
    const trimmed = removeShapeById(shapes, shapes[1]?.id ?? "")?.shapes ?? [];
    // Reusing a freed id would let an undo reattach edits to the wrong shape.
    expect(trimmed.some((shape) => shape.id === nextShapeId(trimmed))).toBe(false);
  });

  it("selects the neighbour after a delete, so a run can be cleared in place", () => {
    const shapes = build(3);
    const middle = shapes[1]?.id ?? "";
    const edit = removeShapeById(shapes, middle);
    expect(edit?.shapes).toHaveLength(2);
    expect(edit?.selectedId).toBe(shapes[2]?.id);
  });

  it("names shapes by what they are and which one", () => {
    let shapes = build(1);
    shapes = duplicateShapeById(shapes, shapes[0]?.id ?? "")?.shapes ?? shapes;
    shapes = addShape(shapes, "cylinder", "pelvis", "body")?.shapes ?? shapes;
    const labels = [...shapeLabels(shapes).values()];
    // "Cylinder 1" says what it is and which one; "Shape 3" says neither.
    expect(labels).toEqual(["Cube 1", "Cube 2", "Cylinder 1"]);
  });
});
