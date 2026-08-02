import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { PaintLayer, type PaintStroke } from "../../src/paint/PaintLayer";
import { baseEmissiveOf, PaintMaterialBinder } from "../../src/paint/PaintMaterialBinder";
import { PAINT_TARGET_COUNT } from "../../src/paint/paintTargets";

/**
 * Per-stroke emissive completes MECCHA's paint panel (CLAUDE.md override 3).
 *
 * The property that matters is that a painted marking glows in the colour it was
 * painted in and that nothing else changes: a body with no glowing paint on it
 * must not allocate the atlas, must not bind the map, and must look exactly as it
 * did before the channel existed.
 */

const ATLAS = 256;

function makeLayer(): PaintLayer {
  return new PaintLayer({ atlasSize: ATLAS, canvas: null });
}

function stroke(overrides: Partial<PaintStroke> = {}): PaintStroke {
  return {
    segmentId: 4,
    uv: [0.5, 0.5],
    radius: 0.3,
    color: [1, 0.5, 0.25],
    opacity: 1,
    kind: "brush",
    continued: false,
    ...overrides,
  };
}

describe("paint layer emissive channel", () => {
  it("has no glow atlas until a stroke asks for one", () => {
    const layer = makeLayer();
    expect(layer.hasEmissive).toBe(false);
    expect(layer.emissivePixelSource()).toBeNull();
    expect(layer.readTargetEmissivePixel(4, 0.5, 0.5)).toBeNull();

    layer.applyStroke(stroke({ emissive: 0 }));
    expect(layer.hasEmissive).toBe(false);

    layer.applyStroke(stroke({ uv: [0.3, 0.3], emissive: 0.5 }));
    expect(layer.hasEmissive).toBe(true);
    expect(layer.emissivePixelSource()).not.toBeNull();
  });

  it("glows in the stroke's own colour, scaled by the emissive amount", () => {
    // The brush is soft, so even its middle texel is a couple of levels short of
    // full coverage. These are the same tolerances the colour atlas is held to.
    const layer = makeLayer();
    layer.applyStroke(stroke({ color: [1, 0.5, 0.25], emissive: 1 }));
    const full = layer.readTargetEmissivePixel(4, 0.5, 0.5) ?? [0, 0, 0];
    expect(full[0]).toBeCloseTo(1, 1);
    expect(full[1]).toBeCloseTo(0.5, 1);
    expect(full[2]).toBeCloseTo(0.25, 1);
    // The glow is the colour, not a grey mask: the channels keep their ratio.
    expect(full[1] / full[0]).toBeCloseTo(0.5, 2);
    expect(full[2] / full[0]).toBeCloseTo(0.25, 2);

    const half = makeLayer();
    half.applyStroke(stroke({ color: [1, 0.5, 0.25], emissive: 0.5 }));
    const dim = half.readTargetEmissivePixel(4, 0.5, 0.5) ?? [0, 0, 0];
    expect(dim[0]).toBeCloseTo(0.5, 1);
    expect(dim[0] / full[0]).toBeCloseTo(0.5, 2);
  });

  it("puts out a glow when matt paint goes over it", () => {
    const layer = makeLayer();
    layer.applyStroke(stroke({ emissive: 1 }));
    expect((layer.readTargetEmissivePixel(4, 0.5, 0.5) ?? [0, 0, 0])[0]).toBeGreaterThan(0.5);

    layer.applyStroke(stroke({ color: [0.1, 0.1, 0.1], emissive: 0 }));
    const covered = layer.readTargetEmissivePixel(4, 0.5, 0.5) ?? [1, 1, 1];
    expect(covered[0]).toBeLessThan(0.02);
    expect(covered[1]).toBeLessThan(0.02);
    expect(covered[2]).toBeLessThan(0.02);
  });

  it("erases the glow back to the part's own, not to black", () => {
    const layer = makeLayer();
    layer.setBaseEmissives([[4, [0.4, 0.2, 0.1]]]);
    layer.applyStroke(stroke({ color: [0, 1, 0], emissive: 1 }));
    expect((layer.readTargetEmissivePixel(4, 0.5, 0.5) ?? [0, 0, 0])[1]).toBeGreaterThan(0.5);

    layer.applyStroke(stroke({ kind: "eraser" }));
    const erased = layer.readTargetEmissivePixel(4, 0.5, 0.5) ?? [0, 0, 0];
    // The eraser is as soft as the brush, so a single pass leaves a trace of
    // what it covered rather than snapping back exactly.
    expect(Math.abs(erased[0] - 0.4)).toBeLessThan(0.03);
    expect(Math.abs(erased[1] - 0.2)).toBeLessThan(0.03);
    expect(Math.abs(erased[2] - 0.1)).toBeLessThan(0.03);
  });

  it("prints the swatch's own glow into an unpainted texel", () => {
    const layer = makeLayer();
    layer.setBaseEmissives([[7, [0.6, 0, 0]]]);
    // The base is remembered even before the atlas exists, so the atlas is
    // printed in the right base the moment a stroke calls it into being.
    layer.applyStroke(stroke({ segmentId: 4, emissive: 1 }));
    const untouched = layer.readTargetEmissivePixel(7, 0.5, 0.5) ?? [0, 0, 0];
    expect(untouched[0]).toBeCloseTo(0.6, 2);
    expect(untouched[1]).toBeCloseTo(0, 2);
  });

  it("reprints the whole log when the atlas arrives late", () => {
    // A matt stroke painted before the atlas existed still has to be covering
    // the swatch's glow once it does, which is why allocation replays the log.
    const late = makeLayer();
    late.setBaseEmissives([[4, [0.8, 0.8, 0.8]]]);
    late.applyStroke(stroke({ color: [0, 0, 0], emissive: 0 }));
    late.applyStroke(stroke({ segmentId: 5, emissive: 1 }));

    const covered = late.readTargetEmissivePixel(4, 0.5, 0.5) ?? [1, 1, 1];
    expect(covered[0]).toBeLessThan(0.02);
  });

  it("carries the glow across the wire to a peer's body", () => {
    const painted = makeLayer();
    painted.applyStroke(stroke({ color: [0.2, 0.9, 1], emissive: 1 }));
    painted.applyStroke(stroke({ segmentId: 9, color: [1, 0, 0], emissive: 0.25 }));

    const received = makeLayer();
    expect(received.fromWireData(painted.toDataForWire())).toBe(true);
    expect(received.hasEmissive).toBe(true);
    for (let target = 0; target < PAINT_TARGET_COUNT; target++) {
      expect(received.readTargetEmissivePixel(target, 0.5, 0.5)).toEqual(
        painted.readTargetEmissivePixel(target, 0.5, 0.5),
      );
    }
  });

  it("leaves an unlit layer byte for byte what it was", () => {
    // The regression this guards: adding a channel must not move a single texel
    // of a body that never asked for one.
    const layer = makeLayer();
    layer.applyStroke(stroke({ metallic: 0.5, smoothness: 0.8 }));
    layer.applyStroke(stroke({ uv: [0.2, 0.7], kind: "eraser" }));
    expect(layer.hasEmissive).toBe(false);
    expect(layer.readTargetPixel(4, 0.5, 0.5)?.[0]).toBeCloseTo(1, 2);
    expect(layer.readTargetMaterialPixel(4, 0.5, 0.5)?.[1]).toBeCloseTo(0.5, 1);
  });
});

describe("baseEmissiveOf", () => {
  it("is black for a material with no emissive at all", () => {
    expect(baseEmissiveOf(undefined, undefined)).toEqual([0, 0, 0]);
  });

  it("folds emissiveIntensity in before converting to sRGB", () => {
    // Intensity multiplies emissive linearly in three, so doubling a linear 0.25
    // gives linear 0.5, and only then does the sRGB transfer curve apply.
    const linear = new THREE.Color().setRGB(0.25, 0.25, 0.25, THREE.LinearSRGBColorSpace);
    const [r] = baseEmissiveOf(linear, 2);
    const expected = new THREE.Color()
      .setRGB(0.5, 0.5, 0.5, THREE.LinearSRGBColorSpace)
      .getRGB(new THREE.Color(), THREE.SRGBColorSpace);
    expect(r).toBeCloseTo(expected.r, 4);
  });

  it("clips rather than wrapping when the source is brighter than white", () => {
    const linear = new THREE.Color().setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
    for (const channel of baseEmissiveOf(linear, 8)) {
      expect(channel).toBeCloseTo(1, 6);
    }
  });
});

describe("paint material binder", () => {
  function paintableMesh(slot: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhysicalMaterial({ color: 0x445566, roughness: 0.4, metalness: 0.2 }),
    );
    mesh.userData["segmentSlot"] = slot;
    return mesh;
  }

  it("leaves emissive alone while the layer has no glow", () => {
    const layer = makeLayer();
    const mesh = paintableMesh(3);
    const binder = new PaintMaterialBinder(layer, () => [mesh]);
    binder.sync();

    const clone = mesh.material as THREE.MeshPhysicalMaterial;
    expect(clone).not.toBe(undefined);
    expect(clone.emissiveMap).toBeNull();
    expect(clone.emissive.getHex()).toBe(0x000000);
    binder.dispose();
  });

  it("re-cuts the material and binds the map once a stroke glows", () => {
    const layer = makeLayer();
    const mesh = paintableMesh(3);
    const binder = new PaintMaterialBinder(layer, () => [mesh]);
    binder.sync();
    const beforeGlow = mesh.material;

    layer.applyStroke(stroke({ segmentId: 3, emissive: 1 }));
    binder.sync();
    const clone = mesh.material as THREE.MeshPhysicalMaterial;
    expect(clone).not.toBe(beforeGlow);
    // White at full strength: the atlas carries the colour and the strength of
    // the glow both, so the material must not tint or scale it.
    expect(clone.emissive.getHex()).toBe(0xffffff);
    expect(clone.emissiveIntensity).toBe(1);

    // The swatch's own colour still reaches the unpainted texel: the second
    // clone was cut from the Mimic's material, never from the first clone.
    expect(clone.color.getHex()).toBe(0xffffff);
    const unpainted = layer.readTargetPixel(3, 0.02, 0.02) ?? [0, 0, 0];
    const swatch = new THREE.Color(0x445566).getRGB(new THREE.Color(), THREE.SRGBColorSpace);
    expect(unpainted[0]).toBeCloseTo(swatch.r, 2);
    expect(unpainted[1]).toBeCloseTo(swatch.g, 2);
    expect(unpainted[2]).toBeCloseTo(swatch.b, 2);
    binder.dispose();
  });

  it("does not re-cut the material on a later sync", () => {
    const layer = makeLayer();
    const mesh = paintableMesh(3);
    const binder = new PaintMaterialBinder(layer, () => [mesh]);
    layer.applyStroke(stroke({ segmentId: 3, emissive: 1 }));
    binder.sync();
    const clone = mesh.material;
    binder.sync();
    binder.sync();
    expect(mesh.material).toBe(clone);
    binder.dispose();
  });

  it("moves a self-lit swatch into the layer's base rather than losing it", () => {
    const layer = makeLayer();
    const mesh = paintableMesh(6);
    const source = mesh.material as THREE.MeshPhysicalMaterial;
    source.emissive.setHex(0x804000);
    source.emissiveIntensity = 1;
    const binder = new PaintMaterialBinder(layer, () => [mesh]);
    layer.applyStroke(stroke({ segmentId: 6, emissive: 1 }));
    binder.sync();

    const expected = baseEmissiveOf(source.emissive, source.emissiveIntensity);
    const unpainted = layer.readTargetEmissivePixel(6, 0.02, 0.02) ?? [0, 0, 0];
    expect(unpainted[0]).toBeCloseTo(expected[0], 2);
    expect(unpainted[1]).toBeCloseTo(expected[1], 2);
    expect(unpainted[2]).toBeCloseTo(expected[2], 2);
    binder.dispose();
  });

  it("puts the Mimic's own materials back on detach", () => {
    const layer = makeLayer();
    const mesh = paintableMesh(3);
    const source = mesh.material;
    const binder = new PaintMaterialBinder(layer, () => [mesh]);
    binder.sync();
    layer.applyStroke(stroke({ segmentId: 3, emissive: 1 }));
    binder.sync();
    binder.detach();
    expect(mesh.material).toBe(source);
  });
});
