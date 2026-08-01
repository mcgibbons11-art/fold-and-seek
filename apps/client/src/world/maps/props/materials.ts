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

/** Materials the map renders but never offers as a sample. */
export const BULB_MATERIAL = "bulb_warm";
export const MOON_BACKDROP_MATERIAL = "moon_backdrop";
/** Lit lampshade and cabinet glazing: sampleable as cloth and as glass. */
export const LAMPSHADE_MATERIAL = "lampshade_linen";
export const GLASS_PANE_MATERIAL = "glass_pane";

const WARM_AMBER = 0xffb066;

export class ShopMaterials {
  private readonly materials = new Map<string, THREE.Material>();
  private readonly textures: THREE.Texture[] = [];
  private readonly grain: THREE.Texture;
  private readonly plaster: THREE.Texture;
  private readonly weave: THREE.Texture;

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

    for (const swatch of SHOP_SWATCHES) {
      this.materials.set(swatch.id, this.buildFromSwatch(swatch));
    }
    this.materials.set(BULB_MATERIAL, this.buildBulb());
    this.materials.set(MOON_BACKDROP_MATERIAL, this.buildBackdrop());
    this.materials.set(LAMPSHADE_MATERIAL, this.buildLampshade());
    this.materials.set(GLASS_PANE_MATERIAL, this.buildGlassPane());
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

  private buildFromSwatch(swatch: MapSwatch): THREE.Material {
    const needsPhysical =
      swatch.clearcoat !== undefined || swatch.sheen !== undefined || swatch.transmission !== undefined;
    const detail = this.detailFor(swatch.family);

    const material = needsPhysical
      ? new THREE.MeshPhysicalMaterial({ roughness: swatch.roughness, metalness: swatch.metalness })
      : new THREE.MeshStandardMaterial({ roughness: swatch.roughness, metalness: swatch.metalness });

    material.name = `shop:${swatch.id}`;
    material.color.setRGB(swatch.baseColor[0], swatch.baseColor[1], swatch.baseColor[2], THREE.SRGBColorSpace);

    if (detail !== null) {
      material.roughnessMap = detail;
      material.bumpMap = detail;
      material.bumpScale = swatch.family === "fabric" ? 0.006 : 0.012;
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
      emissiveIntensity: 0.45,
    });
    material.name = "shop:lampshade";
    material.userData["swatchId"] = "linen_cream_02";
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
