import * as THREE from "three/webgpu";
import { DisposalBag } from "../../../engine/DisposalBag";
import type { QualitySettings } from "../../../rendering/quality";
import { SHOP_SWATCHES, shopSwatch, type MapSwatch } from "../swatches";
import {
  SHOP_SURFACES,
  SURFACE_SCALE_BY_TIER,
  surfaceForSwatch,
  surfaceSizeFor,
  type SurfaceId,
  type SurfaceSpec,
} from "./surfaces";

/**
 * One material per published swatch, plus the handful of surfaces the map
 * deliberately keeps out of the sample catalogue.
 *
 * A material is shared by every mesh wearing it, which is what makes the
 * repeated families instanceable, and it carries its swatch id so the Forge
 * resolves a sample to an approved id rather than reading colour off the
 * renderer (§7.12). Meshes carry the same id so a per-mesh override stays
 * possible for one-offs.
 *
 * The maps themselves are generated here from the fields in `surfaces.ts`, one
 * pair of canvases per surface however many swatches wear it.
 */

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * A surface's two maps and the mean the colour map costs it.
 *
 * A colour map only ever darkens, because a texel cannot exceed one. The mean
 * is reported in the renderer's linear working space so the material can divide
 * its base colour by it and land back on the swatch it published, which keeps
 * the sampled colour and the rendered colour the same thing (§7.12).
 */
interface RenderedSurface {
  readonly spec: SurfaceSpec;
  readonly albedo: THREE.CanvasTexture;
  readonly detail: THREE.CanvasTexture;
  readonly linearMean: number;
}

/**
 * Vertical gradient down a lampshade: hottest at the hem where the bulb is
 * closest, falling off towards the heading. A flat emissive shade reads as a
 * white cylinder, which is what made every lamp in the room a featureless blob.
 */
function createShadeGradient(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Curiosity Shop: 2D canvas context unavailable, cannot build the lampshade gradient");
  }
  // Canvas row 0 is the top of the texture, and three flips it onto v = 1, so
  // the dim end is authored first and the hot hem last.
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#4a2f18");
  gradient.addColorStop(0.55, "#c98f4d");
  gradient.addColorStop(1, "#ffe4bd");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * How far a family's copies may drift from the published swatch. Ceramic and
 * paper stock varies piece to piece; a painted carcass barely does, and glass
 * not at all.
 */
const TINT_VARIANCE: Readonly<Record<MapSwatch["family"], number>> = {
  wood: 0.11,
  paint: 0.07,
  metal: 0.08,
  fabric: 0.09,
  ceramic: 0.14,
  glass: 0,
  paper: 0.12,
  plastic: 0.05,
  stone: 0.07,
};

/** Materials the map renders but never offers as a sample. */
export const BULB_MATERIAL = "bulb_warm";
export const MOON_BACKDROP_MATERIAL = "moon_backdrop";
/** Lit lampshade and cabinet glazing: sampleable as cloth and as glass. */
export const LAMPSHADE_MATERIAL = "lampshade_linen";
export const GLASS_PANE_MATERIAL = "glass_pane";
/** Cold CRT wash in the Security Office: the one cool practical in the map. */
export const SCREEN_MATERIAL = "screen_phosphor";
/**
 * The walls, which wear cream plaster in wall space rather than in metres.
 *
 * They are their own material because `buildWalls` re-projects their texture
 * coordinates so v runs from the skirting to the ceiling, while the painted
 * boxes and partitions sharing the same swatch ride the extruder's own metres.
 * One material cannot answer both conventions. The swatch it publishes is still
 * `paint_cream_01`, so sampling a wall hands back the id it always did.
 */
export const WALL_PLASTER_MATERIAL = "wall_plaster";

const WARM_AMBER = 0xffb066;

/**
 * A single white texel, bound wherever a family has no procedural surface.
 *
 * **This is a shader consolidation, not a look.** Three r185 keys a compiled
 * program on the generated shader SOURCE, and the presence or absence of a
 * texture slot is a branch in the generator (`MaterialNode` tests
 * `material.map`, `material.roughnessMap` and `material.bumpMap` one by one), so
 * a shop where brass carries no maps and walnut carries three is a shop with two
 * of every program in it. On the ANGLE/D3D11 path a program costs over a second
 * to link, which is the load the player waits through.
 *
 * **The pixel is provably unchanged.** A white texel is 1.0 in the renderer's
 * linear working space whichever colour space it is tagged with, so the colour
 * map multiplies the swatch by one; the roughness map's green channel is one, so
 * the swatch's roughness is untouched; and a constant bump map has a zero
 * gradient, with `bumpScale` set to zero besides. Nothing here needs the mean
 * compensation `dress` applies, because the mean is exactly one.
 */
function createNeutralTexture(colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class ShopMaterials {
  private readonly materials = new Map<string, THREE.Material>();
  private readonly textures: THREE.Texture[] = [];
  private readonly surfaces = new Map<SurfaceId, RenderedSurface>();
  private readonly neutralAlbedo: THREE.DataTexture;
  private readonly neutralDetail: THREE.DataTexture;

  constructor(
    private readonly bag: DisposalBag,
    quality: QualitySettings,
  ) {
    this.neutralAlbedo = this.registerTexture(createNeutralTexture(THREE.SRGBColorSpace));
    this.neutralDetail = this.registerTexture(createNeutralTexture(THREE.NoColorSpace));

    const scale = SURFACE_SCALE_BY_TIER[quality.tier];
    for (const spec of Object.values(SHOP_SURFACES)) {
      this.surfaces.set(spec.id, this.renderSurface(spec, scale));
    }

    for (const swatch of SHOP_SWATCHES) {
      this.materials.set(swatch.id, this.buildFromSwatch(swatch));
    }
    this.materials.set(WALL_PLASTER_MATERIAL, this.buildWallPlaster());
    this.materials.set(BULB_MATERIAL, this.buildBulb());
    this.materials.set(MOON_BACKDROP_MATERIAL, this.buildBackdrop());
    this.materials.set(LAMPSHADE_MATERIAL, this.buildLampshade());
    this.materials.set(GLASS_PANE_MATERIAL, this.buildGlassPane());
    this.materials.set(SCREEN_MATERIAL, this.buildScreen());
  }

  get(id: string): THREE.Material {
    const material = this.materials.get(id);
    if (material === undefined) {
      throw new Error(`Curiosity Shop: no material published for id "${id}"`);
    }
    return material;
  }

  /** Swatch a material publishes, or null when it is deliberately unsampleable. */
  swatchIdOf(id: string): string | null {
    const declared = this.get(id).userData["swatchId"];
    return typeof declared === "string" ? declared : null;
  }

  setAnisotropy(anisotropy: number): void {
    for (const texture of this.textures) {
      if (texture.anisotropy !== anisotropy) {
        texture.anisotropy = anisotropy;
        texture.needsUpdate = true;
      }
    }
  }

  private registerTexture<T extends THREE.Texture>(texture: T): T {
    this.bag.add(texture);
    this.textures.push(texture);
    return texture;
  }

  /**
   * Renders a surface's colour and roughness maps in one pass over its texels.
   *
   * The two maps are the same field over different output ranges, so evaluating
   * it once and writing both is half the work of building them separately —
   * which matters, because the whole set is generated inside the frame that
   * opens the map build with a loading bar behind it.
   */
  private renderSurface(spec: SurfaceSpec, scale: number): RenderedSurface {
    const { width, height } = surfaceSizeFor(spec, scale);
    const albedoCanvas = document.createElement("canvas");
    const detailCanvas = document.createElement("canvas");
    albedoCanvas.width = width;
    albedoCanvas.height = height;
    detailCanvas.width = width;
    detailCanvas.height = height;
    const albedoContext = albedoCanvas.getContext("2d");
    const detailContext = detailCanvas.getContext("2d");
    if (albedoContext === null || detailContext === null) {
      throw new Error(`Curiosity Shop: 2D canvas context unavailable, cannot build the "${spec.id}" maps`);
    }

    const albedoImage = albedoContext.createImageData(width, height);
    const detailImage = detailContext.createImageData(width, height);
    const albedoSpan = 1 - spec.albedoFloor;
    const roughSpan = 1 - spec.roughnessFloor;
    let linearSum = 0;

    for (let y = 0; y < height; y += 1) {
      const v = (y + 0.5) / height;
      for (let x = 0; x < width; x += 1) {
        const u = (x + 0.5) / width;
        const value = spec.field(u, v);
        const albedoLevel = Math.round((spec.albedoFloor + value * albedoSpan) * 255);
        const offset = (y * width + x) * 4;
        albedoImage.data[offset] = albedoLevel;
        albedoImage.data[offset + 1] = albedoLevel;
        albedoImage.data[offset + 2] = albedoLevel;
        albedoImage.data[offset + 3] = 255;
        // Red is height and green is roughness, and they run opposite ways: a
        // grain line is a groove *and* is rougher than the planed face beside
        // it, and a thread crown stands proud *and* takes a cleaner highlight
        // than the shadow between threads. One greyscale map cannot say both.
        detailImage.data[offset] = Math.round(value * 255);
        detailImage.data[offset + 1] = Math.round((spec.roughnessFloor + (1 - value) * roughSpan) * 255);
        detailImage.data[offset + 2] = 0;
        detailImage.data[offset + 3] = 255;
        linearSum += srgbToLinear(albedoLevel / 255);
      }
    }
    albedoContext.putImageData(albedoImage, 0, 0);
    detailContext.putImageData(detailImage, 0, 0);

    const wrapT = spec.clampV ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    const albedo = this.registerTexture(new THREE.CanvasTexture(albedoCanvas));
    albedo.colorSpace = THREE.SRGBColorSpace;
    albedo.wrapS = THREE.RepeatWrapping;
    albedo.wrapT = wrapT;
    albedo.repeat.set(spec.repeat[0], spec.repeat[1]);
    albedo.needsUpdate = true;

    const detail = this.registerTexture(new THREE.CanvasTexture(detailCanvas));
    detail.colorSpace = THREE.NoColorSpace;
    detail.wrapS = THREE.RepeatWrapping;
    detail.wrapT = wrapT;
    detail.repeat.set(spec.repeat[0], spec.repeat[1]);
    detail.needsUpdate = true;

    return { spec, albedo, detail, linearMean: linearSum / (width * height) };
  }

  private surfaceFor(id: SurfaceId): RenderedSurface {
    const rendered = this.surfaces.get(id);
    if (rendered === undefined) {
      throw new Error(`Curiosity Shop: surface "${id}" was never rendered`);
    }
    return rendered;
  }

  /**
   * Binds the white texel to the three map slots a dressed material fills, so a
   * family with no procedural surface still generates the same shader as one
   * that has one. Every lit material in the shop goes through this or `dress`,
   * and `shopMaterials.test.ts` holds them to it.
   */
  private dressNeutral(material: THREE.MeshStandardMaterial): void {
    material.map = this.neutralAlbedo;
    material.roughnessMap = this.neutralDetail;
    material.bumpMap = this.neutralDetail;
    material.bumpScale = 0;
  }

  /** Binds a surface's maps onto a material and compensates its base colour. */
  private dress(material: THREE.MeshStandardMaterial, surface: RenderedSurface): void {
    material.roughnessMap = surface.detail;
    material.bumpMap = surface.detail;
    material.bumpScale = surface.spec.bumpScale;
    material.map = surface.albedo;
    // A colour map only darkens, so the base colour is lifted by exactly what
    // the map's mean takes away and the surface still averages to its swatch.
    material.color.multiplyScalar(1 / surface.linearMean);
  }

  private buildFromSwatch(swatch: MapSwatch): THREE.Material {
    const needsPhysical =
      swatch.clearcoat !== undefined || swatch.sheen !== undefined || swatch.transmission !== undefined;

    const material = needsPhysical
      ? new THREE.MeshPhysicalMaterial({ roughness: swatch.roughness, metalness: swatch.metalness })
      : new THREE.MeshStandardMaterial({ roughness: swatch.roughness, metalness: swatch.metalness });

    material.name = `shop:${swatch.id}`;
    material.color.setRGB(swatch.baseColor[0], swatch.baseColor[1], swatch.baseColor[2], THREE.SRGBColorSpace);
    // Per-copy tint rides on the vertex colours the geometry cache guarantees.
    material.vertexColors = true;
    material.userData["tintVariance"] = TINT_VARIANCE[swatch.family];

    const surfaceId = surfaceForSwatch(swatch);
    if (surfaceId === null) {
      this.dressNeutral(material);
    } else {
      this.dress(material, this.surfaceFor(surfaceId));
    }

    if (material instanceof THREE.MeshPhysicalMaterial) {
      material.clearcoat = swatch.clearcoat ?? 0;
      material.clearcoatRoughness = 0.28;
      material.sheen = swatch.sheen ?? 0;
      if (material.sheen > 0) {
        material.sheenRoughness = 0.45;
        material.sheenColor.setHex(0xc09080, THREE.SRGBColorSpace);
      }
      if (swatch.transmission !== undefined) {
        // The blockout approximates transmission with alpha rather than paying
        // for a transmission pass on every cabinet pane. The published swatch
        // still describes the physical material the final pass will use.
        material.transparent = true;
        material.opacity = 1 - swatch.transmission * 0.82;
        material.depthWrite = false;
        material.ior = 1.5;
      }
    }

    material.userData["swatchId"] = swatch.id;
    return this.bag.add(material);
  }

  /** Cream plaster in wall space. Sampleable, and as `paint_cream_01`. */
  private buildWallPlaster(): THREE.Material {
    const swatch = shopSwatch("paint_cream_01");
    if (swatch === null) {
      throw new Error("Curiosity Shop: the walls' swatch paint_cream_01 is missing from the catalogue");
    }
    const material = new THREE.MeshStandardMaterial({
      roughness: swatch.roughness,
      metalness: swatch.metalness,
    });
    material.name = "shop:wall-plaster";
    material.color.setRGB(swatch.baseColor[0], swatch.baseColor[1], swatch.baseColor[2], THREE.SRGBColorSpace);
    material.vertexColors = true;
    material.userData["tintVariance"] = TINT_VARIANCE[swatch.family];
    this.dress(material, this.surfaceFor("wall_plaster"));
    material.userData["swatchId"] = swatch.id;
    return this.bag.add(material);
  }

  /** Bright enough to clear the bloom threshold the pipeline uses (§18.5). */
  private buildBulb(): THREE.Material {
    const material = new THREE.MeshStandardMaterial({
      color: 0x201404,
      roughness: 0.3,
      emissive: new THREE.Color(WARM_AMBER),
      emissiveIntensity: 7,
    });
    material.name = "shop:bulb";
    // The bulb wears the same slots and the same vertex-colour flag as every
    // other lit material so that it shares their program. Both are no-ops on
    // the pixel: the map is white and every colour attribute in the shop that
    // reaches an undressed material is exactly white (the bevel wear is written
    // only by `extrudeProfile`, and a bulb is a lathe).
    material.vertexColors = true;
    this.dressNeutral(material);
    return this.bag.add(material);
  }

  private buildBackdrop(): THREE.Material {
    const material = new THREE.MeshBasicMaterial({ color: 0x141f33 });
    material.name = "shop:moon-backdrop";
    return this.bag.add(material);
  }

  private buildLampshade(): THREE.Material {
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xf2e3c8,
      roughness: 0.74,
      metalness: 0,
      side: THREE.DoubleSide,
      sheen: 0.4,
      emissive: new THREE.Color(0xffcf9c),
      // The gradient costs most of the shade its glow, so the peak is raised to
      // keep the hem over the bloom threshold the pipeline uses (§18.5).
      emissiveIntensity: 1.5,
    });
    material.name = "shop:lampshade";
    material.emissiveMap = this.registerTexture(createShadeGradient());
    material.vertexColors = true;
    this.dressNeutral(material);
    material.userData["swatchId"] = "linen_cream_02";
    return this.bag.add(material);
  }

  /**
   * Monitor phosphor. The Security Office is the only room lit cold, which is
   * what makes it read as a different place rather than as more shop (§5.7).
   */
  private buildScreen(): THREE.Material {
    const material = new THREE.MeshStandardMaterial({
      color: 0x0a1218,
      roughness: 0.22,
      metalness: 0,
      emissive: new THREE.Color(0x4e86a8),
      emissiveIntensity: 2.4,
    });
    material.name = "shop:screen";
    material.userData["swatchId"] = "bakelite_black_01";
    material.userData["tintVariance"] = 0.16;
    material.vertexColors = true;
    this.dressNeutral(material);
    return this.bag.add(material);
  }

  private buildGlassPane(): THREE.Material {
    const swatch = shopSwatch("glass_cabinet_01");
    const material = new THREE.MeshPhysicalMaterial({
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      side: THREE.DoubleSide,
      ior: 1.5,
    });
    material.name = "shop:glass-pane";
    material.vertexColors = true;
    this.dressNeutral(material);
    if (swatch !== null) {
      material.color.setRGB(swatch.baseColor[0], swatch.baseColor[1], swatch.baseColor[2], THREE.SRGBColorSpace);
    }
    material.userData["swatchId"] = "glass_cabinet_01";
    return this.bag.add(material);
  }
}
