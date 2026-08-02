// @vitest-environment jsdom
import * as THREE from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DisposalBag } from "../../src/engine/DisposalBag";
import { qualitySettingsFor } from "../../src/rendering/quality";
import {
  ShopMaterials,
  WALL_PLASTER_MATERIAL,
  GLASS_PANE_MATERIAL,
  LAMPSHADE_MATERIAL,
} from "../../src/world/maps/props/materials";
import { SHOP_SURFACES, surfaceForSwatch, surfaceSizeFor, type SurfaceId } from "../../src/world/maps/props/surfaces";
import { SHOP_SWATCHES } from "../../src/world/maps/swatches";

/**
 * The library actually built, rather than the fields it is built from.
 *
 * jsdom has no 2D canvas, so the surfaces are rendered against the smallest
 * context that satisfies the generator: it writes into an ImageData and hands
 * it back, which is every call `renderSurface` makes. That is enough to run the
 * real constructor, and running the real constructor is the point — the field
 * tests cannot catch a swatch bound to the wrong map, a material registered
 * under an id nothing asks for, or a canvas built per prop instead of per
 * family, and all three are how this would go wrong.
 */

interface StubContext {
  createImageData(width: number, height: number): ImageData;
  putImageData(image: ImageData, x: number, y: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(): void };
  fillRect(x: number, y: number, width: number, height: number): void;
  fillStyle: unknown;
}

/** Canvases handed out during a construction, so they can be counted. */
let canvases: HTMLCanvasElement[] = [];
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
let originalCreateElement: typeof document.createElement;

beforeEach(() => {
  canvases = [];
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  originalCreateElement = document.createElement.bind(document);

  HTMLCanvasElement.prototype.getContext = function stubGetContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== "2d") {
      return null;
    }
    const context: StubContext = {
      createImageData: (width, height) =>
        ({ data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: "srgb" }) as ImageData,
      putImageData: () => undefined,
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      fillRect: () => undefined,
      fillStyle: "",
    };
    return context as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;

  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = originalCreateElement(tag, options);
    if (tag === "canvas") {
      canvases.push(element as HTMLCanvasElement);
    }
    return element;
  }) as typeof document.createElement;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  document.createElement = originalCreateElement;
});

function build(tier: Parameters<typeof qualitySettingsFor>[0] = "ultra"): {
  materials: ShopMaterials;
  bag: DisposalBag;
} {
  const bag = new DisposalBag();
  return { materials: new ShopMaterials(bag, qualitySettingsFor(tier, "webgl2")), bag };
}

describe("ShopMaterials", () => {
  it("builds every published swatch and the map's own extra materials", () => {
    const { materials, bag } = build();
    for (const swatch of SHOP_SWATCHES) {
      expect(materials.get(swatch.id).userData["swatchId"], swatch.id).toBe(swatch.id);
    }
    // The walls publish cream plaster while wearing a map of their own, so a
    // player sampling a wall still copies an id the catalogue knows.
    expect(materials.swatchIdOf(WALL_PLASTER_MATERIAL)).toBe("paint_cream_01");
    expect(materials.swatchIdOf(GLASS_PANE_MATERIAL)).toBe("glass_cabinet_01");
    expect(materials.swatchIdOf(LAMPSHADE_MATERIAL)).toBe("linen_cream_02");
    expect(() => materials.get("no_such_material")).toThrow();
    bag.dispose();
  });

  it("spends two canvases per surface, not two per swatch", () => {
    const { bag } = build();
    // Sixteen surface canvases and one lampshade gradient. A map built per
    // swatch would be fifty-odd, which is the regression this guards.
    expect(canvases.length).toBe(Object.keys(SHOP_SURFACES).length * 2 + 1);
    bag.dispose();
  });

  it("hands every swatch of a family the identical texture objects", () => {
    const { materials, bag } = build();
    const seen = new Map<SurfaceId, THREE.Texture>();
    for (const swatch of SHOP_SWATCHES) {
      const id = surfaceForSwatch(swatch);
      const material = materials.get(swatch.id) as THREE.MeshStandardMaterial;
      if (id === null) {
        expect(material.map, swatch.id).toBeNull();
        expect(material.roughnessMap, swatch.id).toBeNull();
        continue;
      }
      expect(material.map, swatch.id).not.toBeNull();
      // One texture serves both, which is what the red and green channels are
      // for: red is height, green is roughness, and they run opposite ways.
      expect(material.bumpMap, swatch.id).toBe(material.roughnessMap);
      expect(material.bumpScale, swatch.id).toBe(SHOP_SURFACES[id].bumpScale);

      const first = seen.get(id);
      if (first === undefined) {
        seen.set(id, material.roughnessMap as THREE.Texture);
        continue;
      }
      expect(material.roughnessMap, `${swatch.id} does not share its family's map`).toBe(first);
    }
    expect(seen.size).toBeGreaterThan(4);
    bag.dispose();
  });

  it("lifts a mapped colour by what the map's mean takes away", () => {
    // The colour map only darkens, so a dressed material carries a base colour
    // above its swatch and averages back onto it. An undressed one is the
    // swatch exactly, and that difference is how the compensation is visible.
    const { materials, bag } = build();
    const walnut = materials.get("walnut_mid_02") as THREE.MeshStandardMaterial;
    const swatch = SHOP_SWATCHES.find((entry) => entry.id === "walnut_mid_02");
    const plainColor = new THREE.Color().setRGB(
      swatch?.baseColor[0] ?? 0,
      swatch?.baseColor[1] ?? 0,
      swatch?.baseColor[2] ?? 0,
      THREE.SRGBColorSpace,
    );
    expect(walnut.color.r).toBeGreaterThan(plainColor.r);
    expect(walnut.color.r / plainColor.r).toBeLessThan(2);

    const brass = materials.get("brass_tarnished_01") as THREE.MeshStandardMaterial;
    expect(brass.map).toBeNull();
    bag.dispose();
  });

  it("builds a weak tier's maps smaller and a strong tier's at full size", () => {
    const { bag } = build("light");
    const expected = surfaceSizeFor(SHOP_SURFACES.wall_plaster, 0.5);
    const wall = canvases.find(
      (canvas) => canvas.width === expected.width && canvas.height === expected.height,
    );
    expect(wall, "no canvas at the light tier's wall size").toBeDefined();
    expect(expected.width).toBeLessThan(SHOP_SURFACES.wall_plaster.width);
    bag.dispose();
  });

  it("registers every texture and material for disposal", () => {
    const { bag } = build();
    // Nothing here reaches a GPU, but a leak is a leak: the bag is the only
    // thing that frees these when a map is torn down between rounds.
    expect(bag.size).toBeGreaterThan(Object.keys(SHOP_SURFACES).length * 2 + SHOP_SWATCHES.length);
    expect(() => {
      bag.dispose();
    }).not.toThrow();
  });
});
