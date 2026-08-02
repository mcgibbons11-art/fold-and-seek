import * as THREE from "three/webgpu";

/**
 * Curated material swatches (bible §7.12). Sampling copies a swatch id, never a
 * colour or a shader, so the set a map publishes is the complete set a disguise
 * can wear. Texture and triplanar fields are declared here because the swatch is
 * the contract the server validates against; the Forge renders the parametric
 * part of a swatch today and the mapped part arrives with the production
 * material library (§7.13).
 */

export type MaterialFamily =
  | "wood"
  | "paint"
  | "metal"
  | "fabric"
  | "ceramic"
  | "glass"
  | "paper"
  | "plastic"
  | "stone";

export interface MaterialSwatch {
  readonly id: string;
  readonly family: MaterialFamily;
  /** sRGB base colour in 0..1. */
  readonly baseColor: readonly [number, number, number];
  readonly roughness: number;
  readonly metalness: number;
  readonly normalTextureId?: string;
  readonly ormTextureId?: string;
  readonly detailTextureId?: string;
  readonly triplanarScale?: number;
  readonly clearcoat?: number;
  readonly sheen?: number;
  readonly emissive?: readonly [number, number, number];
  readonly legalForMimic: boolean;
  /** Shown in the Forge material tray. */
  readonly label: string;
}

/** The swatch a Mimic wears before the player samples anything (§17.3). */
export const PORCELAIN_SWATCH_ID = "mimic_porcelain";

export const MATERIAL_SWATCHES: readonly MaterialSwatch[] = [
  {
    id: PORCELAIN_SWATCH_ID,
    // The default body finish. A near-neutral white that stays white under the
    // shop's warm practicals, matte enough that the form is described by shading
    // rather than by highlights, with just enough clearcoat to catch a rim. The
    // glossier cream this replaced blew out to a flat bright shape against
    // colourful clutter, which is exactly where the silhouette has to read.
    label: "Porcelain",
    family: "ceramic",
    baseColor: [0.93, 0.915, 0.893],
    roughness: 0.62,
    metalness: 0,
    clearcoat: 0.25,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "wood_walnut",
    label: "Walnut",
    family: "wood",
    baseColor: [0.353, 0.227, 0.133],
    roughness: 0.55,
    metalness: 0,
    triplanarScale: 1.4,
    legalForMimic: true,
  },
  {
    id: "metal_brass",
    label: "Tarnished brass",
    family: "metal",
    baseColor: [0.69, 0.541, 0.29],
    roughness: 0.34,
    metalness: 0.95,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "metal_patina",
    label: "Oxidized copper",
    family: "metal",
    baseColor: [0.302, 0.478, 0.408],
    roughness: 0.45,
    metalness: 0.55,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "fabric_velvet_burgundy",
    label: "Burgundy velvet",
    family: "fabric",
    baseColor: [0.263, 0.067, 0.133],
    roughness: 0.92,
    metalness: 0,
    sheen: 1,
    triplanarScale: 2.2,
    legalForMimic: true,
  },
  {
    id: "fabric_cream_linen",
    label: "Cream linen",
    family: "fabric",
    baseColor: [0.949, 0.89, 0.784],
    roughness: 0.78,
    metalness: 0,
    sheen: 0.45,
    triplanarScale: 2.2,
    legalForMimic: true,
  },
  {
    id: "fabric_wool_midnight",
    label: "Midnight wool",
    family: "fabric",
    baseColor: [0.106, 0.153, 0.259],
    roughness: 0.88,
    metalness: 0,
    sheen: 0.3,
    triplanarScale: 2.6,
    legalForMimic: true,
  },
  {
    id: "paint_midnight",
    label: "Midnight paint",
    family: "paint",
    baseColor: [0.106, 0.153, 0.259],
    roughness: 0.42,
    metalness: 0,
    clearcoat: 0.2,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    id: "paint_plaster",
    label: "Warm plaster",
    family: "paint",
    baseColor: [0.847, 0.796, 0.714],
    roughness: 0.95,
    metalness: 0,
    triplanarScale: 1.2,
    legalForMimic: true,
  },
  {
    id: "ceramic_glazed",
    label: "Glazed ceramic",
    family: "ceramic",
    baseColor: [0.898, 0.867, 0.796],
    roughness: 0.18,
    metalness: 0,
    clearcoat: 0.8,
    triplanarScale: 1,
    legalForMimic: true,
  },
  {
    // Published so the Inspector's world can reference it, refused on a body:
    // a Mimic wearing a lit window would read as a light source, not an object.
    id: "glass_window",
    label: "Window glass",
    family: "glass",
    baseColor: [0.102, 0.153, 0.251],
    roughness: 0.08,
    metalness: 0,
    emissive: [0.06, 0.09, 0.16],
    legalForMimic: false,
  },
];

const swatchesById = new Map<string, MaterialSwatch>(
  MATERIAL_SWATCHES.map((swatch) => [swatch.id, swatch]),
);

export function swatchById(id: string): MaterialSwatch | null {
  return swatchesById.get(id) ?? null;
}

/** True when the swatch exists and the map allows it on a disguise. */
export function isSwatchLegalForMimic(id: string): boolean {
  return swatchesById.get(id)?.legalForMimic === true;
}

export const MIMIC_LEGAL_SWATCHES: readonly MaterialSwatch[] = MATERIAL_SWATCHES.filter(
  (swatch) => swatch.legalForMimic,
);

/** Dark graphite of the joint bellows and the mechanical interior (§17.3). */
export const GRAPHITE_COLOR = 0x1e1c1b;

/**
 * Builds one material per swatch, on demand, and hands the same instance to
 * every segment wearing that swatch. Segment materials are swapped by reference,
 * so a material assignment costs no shader compile after the first use.
 */
export class SwatchMaterialCache {
  private readonly materials = new Map<string, THREE.MeshPhysicalMaterial>();

  get(id: string): THREE.MeshPhysicalMaterial {
    const existing = this.materials.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const swatch = swatchById(id) ?? swatchById(PORCELAIN_SWATCH_ID);
    if (swatch === null) {
      throw new Error("Material swatch catalogue is missing its porcelain default");
    }
    const material = new THREE.MeshPhysicalMaterial({
      roughness: swatch.roughness,
      metalness: swatch.metalness,
      clearcoat: swatch.clearcoat ?? 0,
      clearcoatRoughness: 0.3,
      sheen: swatch.sheen ?? 0,
    });
    material.name = `swatch:${swatch.id}`;
    material.color.setRGB(
      swatch.baseColor[0],
      swatch.baseColor[1],
      swatch.baseColor[2],
      THREE.SRGBColorSpace,
    );
    if (swatch.sheen !== undefined && swatch.sheen > 0) {
      material.sheenRoughness = 0.5;
      material.sheenColor.setRGB(0.75, 0.55, 0.5, THREE.SRGBColorSpace);
    }
    if (swatch.emissive !== undefined) {
      material.emissive.setRGB(
        swatch.emissive[0],
        swatch.emissive[1],
        swatch.emissive[2],
        THREE.SRGBColorSpace,
      );
    }
    this.materials.set(swatch.id, material);
    return material;
  }

  dispose(): void {
    for (const material of this.materials.values()) {
      material.dispose();
    }
    this.materials.clear();
  }

  /** How many swatch materials exist, for counting what a scene compiles. */
  get size(): number {
    return this.materials.size;
  }
}

/**
 * Every material a Mimic body wears, in one place so several bodies can share
 * them.
 *
 * Four bodies standing in the room is four of everything below unless they are
 * handed the same pool, and each distinct material is a shader the backend has
 * to build before the first frame that draws it. Identical unpainted parts have
 * no reason to be built four times, so the theatre gives its whole cast one
 * pool and the bodies differ only in geometry.
 *
 * The eyes are two materials rather than one with a mutable intensity: a locked
 * disguise closes its shutters, and a shared material cannot be dark for one
 * body and lit for another. Swapping the reference costs nothing and both
 * variants are built once.
 */
export class MimicMaterialPool {
  readonly swatches = new SwatchMaterialCache();
  readonly graphite: THREE.MeshPhysicalMaterial;
  readonly brass: THREE.MeshPhysicalMaterial;
  readonly eyeLit: THREE.MeshStandardMaterial;
  readonly eyeShut: THREE.MeshStandardMaterial;

  constructor() {
    this.graphite = new THREE.MeshPhysicalMaterial({
      color: GRAPHITE_COLOR,
      roughness: 0.72,
      metalness: 0.15,
    });
    this.graphite.name = "mimic_graphite";
    this.brass = new THREE.MeshPhysicalMaterial({ color: 0xb08a4a, roughness: 0.38, metalness: 0.9 });
    this.brass.name = "mimic_socket_brass";
    this.eyeLit = new THREE.MeshStandardMaterial({
      color: 0x120c05,
      roughness: 0.2,
      emissive: new THREE.Color(0xffc47a),
      emissiveIntensity: 5,
    });
    this.eyeLit.name = "mimic_eye_lit";
    this.eyeShut = this.eyeLit.clone();
    this.eyeShut.name = "mimic_eye_shut";
    this.eyeShut.emissiveIntensity = 0;
  }

  /** Distinct materials built so far, which is what a compile pass has to cover. */
  get size(): number {
    return this.swatches.size + 4;
  }

  dispose(): void {
    this.swatches.dispose();
    this.graphite.dispose();
    this.brass.dispose();
    this.eyeLit.dispose();
    this.eyeShut.dispose();
  }
}
