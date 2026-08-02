import * as THREE from "three/webgpu";
import { DisposalBag } from "../../../engine/DisposalBag";
import { SHOP_SWATCHES, shopSwatch, type MapSwatch } from "../swatches";

/**
 * One material per published swatch, plus the handful of surfaces the map
 * deliberately keeps out of the sample catalogue.
 *
 * A material is shared by every mesh wearing it, which is what makes the
 * repeated families instanceable, and it carries its swatch id so the Forge
 * resolves a sample to an approved id rather than reading colour off the
 * renderer (§7.12). Meshes carry the same id so a per-mesh override stays
 * possible for one-offs.
 */

const NOISE_SIZE = 256;

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Tileable value noise: grid indices wrap, so RepeatWrapping shows no seam. */
function tileableNoise(size: number, baseCells: number, octaves: number, seed: number): Float32Array {
  const field = new Float32Array(size * size);
  const random = makeRandom(seed);
  let amplitude = 1;
  let amplitudeSum = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    const cells = baseCells * (1 << octave);
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i += 1) {
      grid[i] = random();
    }

    const scale = cells / size;
    for (let y = 0; y < size; y += 1) {
      const gy = y * scale;
      const gy0 = Math.floor(gy);
      const fy = smoothStep(gy - gy0);
      const row0 = (((gy0 % cells) + cells) % cells) * cells;
      const row1 = ((((gy0 + 1) % cells) + cells) % cells) * cells;

      for (let x = 0; x < size; x += 1) {
        const gx = x * scale;
        const gx0 = Math.floor(gx);
        const fx = smoothStep(gx - gx0);
        const col0 = ((gx0 % cells) + cells) % cells;
        const col1 = (((gx0 + 1) % cells) + cells) % cells;

        const v00 = grid[row0 + col0] ?? 0;
        const v10 = grid[row0 + col1] ?? 0;
        const v01 = grid[row1 + col0] ?? 0;
        const v11 = grid[row1 + col1] ?? 0;
        const top = v00 + (v10 - v00) * fx;
        const bottom = v01 + (v11 - v01) * fx;
        field[y * size + x] = (field[y * size + x] ?? 0) + (top + (bottom - top) * fy) * amplitude;
      }
    }

    amplitudeSum += amplitude;
    amplitude *= 0.5;
  }

  for (let i = 0; i < field.length; i += 1) {
    field[i] = (field[i] ?? 0) / amplitudeSum;
  }
  return field;
}

interface NoiseOptions {
  readonly cells: number;
  readonly octaves: number;
  readonly seed: number;
  readonly low: number;
  readonly high: number;
  readonly repeat: number;
  /** Anisotropic stretch applied before sampling, which is what makes grain. */
  readonly stretch: number;
}

/**
 * A colour map only ever darkens, because a texel cannot exceed one. The mean
 * is reported in the renderer's linear working space so a material can divide
 * its base colour by it and land back on the swatch it published, which keeps
 * the sampled colour and the rendered colour the same thing (§7.12).
 */
interface DetailTexture {
  readonly texture: THREE.CanvasTexture;
  readonly linearMean: number;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function createNoiseTexture(options: NoiseOptions): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = NOISE_SIZE;
  canvas.height = NOISE_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Curiosity Shop: 2D canvas context unavailable, cannot build procedural surface noise");
  }

  const field = tileableNoise(NOISE_SIZE, options.cells, options.octaves, options.seed);
  const image = context.createImageData(NOISE_SIZE, NOISE_SIZE);
  const span = options.high - options.low;

  for (let y = 0; y < NOISE_SIZE; y += 1) {
    for (let x = 0; x < NOISE_SIZE; x += 1) {
      const sx = Math.floor(x / options.stretch) % NOISE_SIZE;
      const value = field[y * NOISE_SIZE + sx] ?? 0.5;
      const level = Math.round((options.low + value * span) * 255);
      const offset = (y * NOISE_SIZE + x) * 4;
      image.data[offset] = level;
      image.data[offset + 1] = level;
      image.data[offset + 2] = level;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.repeat.set(options.repeat, options.repeat);
  texture.needsUpdate = true;
  return texture;
}

/** The same field as an sRGB albedo map, with its linear mean measured. */
function createAlbedoTexture(options: NoiseOptions): DetailTexture {
  const texture = createNoiseTexture(options);
  texture.colorSpace = THREE.SRGBColorSpace;

  let sum = 0;
  let count = 0;
  const span = options.high - options.low;
  const field = tileableNoise(NOISE_SIZE, options.cells, options.octaves, options.seed);
  for (let y = 0; y < NOISE_SIZE; y += 1) {
    for (let x = 0; x < NOISE_SIZE; x += 1) {
      const sx = Math.floor(x / options.stretch) % NOISE_SIZE;
      const value = field[y * NOISE_SIZE + sx] ?? 0.5;
      sum += srgbToLinear(Math.round((options.low + value * span) * 255) / 255);
      count += 1;
    }
  }
  return { texture, linearMean: count === 0 ? 1 : sum / count };
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

const WARM_AMBER = 0xffb066;

export class ShopMaterials {
  private readonly materials = new Map<string, THREE.Material>();
  private readonly textures: THREE.Texture[] = [];
  private readonly grain: THREE.Texture;
  private readonly plaster: THREE.Texture;
  private readonly weave: THREE.Texture;
  /** Albedo break-up, keyed by the detail map it accompanies. */
  private readonly grainAlbedo: DetailTexture;
  private readonly plasterAlbedo: DetailTexture;
  private readonly weaveAlbedo: DetailTexture;

  constructor(private readonly bag: DisposalBag) {
    this.grain = this.registerTexture(
      createNoiseTexture({ cells: 6, octaves: 4, seed: 29, low: 0.42, high: 0.96, repeat: 3, stretch: 8 }),
    );
    this.plaster = this.registerTexture(
      createNoiseTexture({ cells: 4, octaves: 4, seed: 11, low: 0.6, high: 1, repeat: 4, stretch: 1 }),
    );
    this.weave = this.registerTexture(
      createNoiseTexture({ cells: 16, octaves: 3, seed: 47, low: 0.62, high: 1, repeat: 6, stretch: 1 }),
    );

    // The albedo share their neighbours' seeds and cell counts, so the colour
    // break-up sits exactly on the grain the bump map already carves. Two
    // uncorrelated noises read as dirt on the lens rather than as a surface.
    this.grainAlbedo = this.registerDetail(
      createAlbedoTexture({ cells: 6, octaves: 4, seed: 29, low: 0.62, high: 1, repeat: 3, stretch: 8 }),
    );
    this.plasterAlbedo = this.registerDetail(
      createAlbedoTexture({ cells: 4, octaves: 4, seed: 11, low: 0.86, high: 1, repeat: 4, stretch: 1 }),
    );
    this.weaveAlbedo = this.registerDetail(
      createAlbedoTexture({ cells: 16, octaves: 3, seed: 47, low: 0.8, high: 1, repeat: 6, stretch: 1 }),
    );

    for (const swatch of SHOP_SWATCHES) {
      this.materials.set(swatch.id, this.buildFromSwatch(swatch));
    }
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

  private registerTexture(texture: THREE.CanvasTexture): THREE.CanvasTexture {
    this.bag.add(texture);
    this.textures.push(texture);
    return texture;
  }

  private registerDetail(detail: DetailTexture): DetailTexture {
    this.registerTexture(detail.texture);
    return detail;
  }

  private detailFor(family: MapSwatch["family"]): THREE.Texture | null {
    switch (family) {
      case "wood":
        return this.grain;
      case "paint":
      case "stone":
      case "paper":
        return this.plaster;
      case "fabric":
        return this.weave;
      default:
        return null;
    }
  }

  private albedoFor(family: MapSwatch["family"]): DetailTexture | null {
    switch (family) {
      case "wood":
        return this.grainAlbedo;
      case "paint":
      case "stone":
      case "paper":
        return this.plasterAlbedo;
      case "fabric":
        return this.weaveAlbedo;
      default:
        return null;
    }
  }

  private buildFromSwatch(swatch: MapSwatch): THREE.Material {
    const needsPhysical =
      swatch.clearcoat !== undefined || swatch.sheen !== undefined || swatch.transmission !== undefined;
    const detail = this.detailFor(swatch.family);

    const material = needsPhysical
      ? new THREE.MeshPhysicalMaterial({ roughness: swatch.roughness, metalness: swatch.metalness })
      : new THREE.MeshStandardMaterial({ roughness: swatch.roughness, metalness: swatch.metalness });

    material.name = `shop:${swatch.id}`;
    material.color.setRGB(swatch.baseColor[0], swatch.baseColor[1], swatch.baseColor[2], THREE.SRGBColorSpace);
    // Per-copy tint rides on the vertex colours the geometry cache guarantees.
    material.vertexColors = true;
    material.userData["tintVariance"] = TINT_VARIANCE[swatch.family];

    if (detail !== null) {
      material.roughnessMap = detail;
      material.bumpMap = detail;
      // The blockout's relief was too fine to survive a lamp four metres away.
      material.bumpScale = swatch.family === "fabric" ? 0.03 : 0.055;
    }

    const albedo = this.albedoFor(swatch.family);
    if (albedo !== null) {
      material.map = albedo.texture;
      // A colour map only darkens, so the base colour is lifted by exactly what
      // the map's mean takes away and the surface still averages to its swatch.
      material.color.multiplyScalar(1 / albedo.linearMean);
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

  /** Bright enough to clear the bloom threshold the pipeline uses (§18.5). */
  private buildBulb(): THREE.Material {
    const material = new THREE.MeshStandardMaterial({
      color: 0x201404,
      roughness: 0.3,
      emissive: new THREE.Color(WARM_AMBER),
      emissiveIntensity: 7,
    });
    material.name = "shop:bulb";
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
    if (swatch !== null) {
      material.color.setRGB(swatch.baseColor[0], swatch.baseColor[1], swatch.baseColor[2], THREE.SRGBColorSpace);
    }
    material.userData["swatchId"] = "glass_cabinet_01";
    return this.bag.add(material);
  }
}
