import { MAX_SHAPES } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import {
  addShape,
  fitScore,
  snapOffset,
  strokeToBoxes,
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

describe("how much of the body a disguise actually hides", () => {
  const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
  const inside = { x: 0, y: 0, z: 0 };
  const outside = { x: 5, y: 0, z: 0 };

  it("scores nothing when nothing has been built", () => {
    // A body with no shapes around it is a creature standing in a room, which
    // is the worst disguise there is rather than a neutral one.
    expect(fitScore([inside], [])).toBe(0);
  });

  it("scores every part that is inside something built", () => {
    expect(fitScore([inside, inside], [box])).toBe(1);
  });

  it("counts what is still sticking out", () => {
    // The number a player acts on: half of them is showing.
    expect(fitScore([inside, outside], [box])).toBeCloseTo(0.5, 6);
  });

  it("counts a part once however many shapes cover it", () => {
    // Stacking shapes on one limb must not read as hiding the whole body,
    // or the cheapest way to a perfect score is a pile on one arm.
    expect(fitScore([inside, outside], [box, box, box])).toBeCloseTo(0.5, 6);
  });
});

describe("closing the gap between two built shapes", () => {
  const box = (x0: number, x1: number) => ({
    min: { x: x0, y: 0, z: 0 },
    max: { x: x1, y: 1, z: 1 },
  });

  it("has nothing to say when there is nothing to snap against", () => {
    expect(snapOffset(box(0, 1), [])).toBeNull();
  });

  it("closes a gap along the axis the shapes are nearest on", () => {
    // A gap of a few millimetres at this scale reads as two objects rather
    // than one, which is the tell a disguise exists to avoid.
    const offset = snapOffset(box(0, 1), [box(1.2, 2.2)]);
    expect(offset?.axis).toBe(0);
    expect(offset?.delta).toBeCloseTo(0.2, 6);
  });

  it("pulls back rather than pushing through when the shapes overlap", () => {
    const offset = snapOffset(box(0, 1), [box(0.8, 1.8)]);
    expect(offset?.delta).toBeCloseTo(-0.2, 6);
  });

  it("says nothing when they already touch", () => {
    expect(snapOffset(box(0, 1), [box(1, 2)])).toBeNull();
  });
});

describe("turning a drawn outline into a disguise", () => {
  const line = (n: number, y: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ x: i / n, y: y(i) }));

  it("ignores a click, which is not a drawing", () => {
    expect(strokeToBoxes([{ x: 0, y: 0 }], 16, 0.01)).toEqual([]);
    expect(strokeToBoxes([{ x: 0, y: 0 }, { x: 0.001, y: 0 }], 16, 0.01)).toEqual([]);
  });

  it("fills each column the stroke crosses, so the outline survives", () => {
    // A tall sweep and a short one must not come back the same, or the drawing
    // said nothing about the shape.
    const tall = strokeToBoxes(line(24, (i) => (i % 2 === 0 ? 0 : 0.8)), 16, 0.01);
    const flat = strokeToBoxes(line(24, () => 0), 16, 0.01);
    expect(tall.length).toBeGreaterThan(0);
    expect(Math.max(...tall.map((b) => b.height))).toBeGreaterThan(
      Math.max(...flat.map((b) => b.height)),
    );
  });

  it("never spends more boxes than the disguise has room for", () => {
    // Sixteen is the wire's ceiling; a drawing that overran it would be
    // silently truncated somewhere less honest than here.
    const busy = strokeToBoxes(line(200, (i) => Math.sin(i) * 0.5), 4, 0.01);
    expect(busy.length).toBeLessThanOrEqual(4);
  });

  it("gives a flat stroke real thickness rather than an invisible sliver", () => {
    const flat = strokeToBoxes(line(24, () => 0.2), 16, 0.02);
    for (const box of flat) expect(box.height).toBeGreaterThanOrEqual(0.02);
  });
});
