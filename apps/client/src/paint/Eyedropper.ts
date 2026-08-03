import * as THREE from "three/webgpu";

import type { PaintPixelSource } from "./PaintLayer";

/**
 * Click-to-copy colour (MECCHA port, CLAUDE.md override 3). The Forge already
 * samples a material *swatch* with F (§7.5); this samples the colour a surface
 * actually shows, which is what a painter needs to match a shelf to the wall
 * behind it.
 *
 * The answer is the displayed base colour: the material's own colour, and where
 * the material has a map, that colour multiplied by the texel under the hit.
 * Multiplying in linear light and returning sRGB is what makes the sampled
 * colour the one the player saw, rather than one two conversions away from it.
 */

export interface EyedropperOptions {
  readonly raycaster: THREE.Raycaster;
  readonly camera: THREE.Camera;
  /**
   * Pixels for textures that change every frame, above all the painter's own
   * atlas. Without it a readback cache would hand back yesterday's paint.
   */
  readonly getPixelSource?: (texture: THREE.Texture) => PaintPixelSource | null;
}

export interface EyedropperSample {
  /** sRGB in 0..1, ready to hand to the brush. */
  readonly color: [number, number, number];
  readonly object: THREE.Object3D;
  readonly point: THREE.Vector3;
}

interface MaterialLike {
  readonly color?: THREE.Color;
  readonly map?: THREE.Texture | null;
  readonly vertexColors?: boolean;
}

const scratchColor = new THREE.Color();
const texelColor = new THREE.Color();
const outColor = new THREE.Color();
const vertexColor = new THREE.Color();
const scratchUv = new THREE.Vector2();
const localPoint = new THREE.Vector3();
const vertexA = new THREE.Vector3();
const vertexB = new THREE.Vector3();
const vertexC = new THREE.Vector3();
const barycentric = new THREE.Vector3();

export class Eyedropper {
  private readonly raycaster: THREE.Raycaster;
  private readonly camera: THREE.Camera;
  private readonly getPixelSource: ((texture: THREE.Texture) => PaintPixelSource | null) | null;
  /** Read-back of static images, keyed by texture uuid. */
  private readonly readbacks = new Map<string, PaintPixelSource | null>();
  private readonly intersections: THREE.Intersection[] = [];

  constructor(options: EyedropperOptions) {
    this.raycaster = options.raycaster;
    this.camera = options.camera;
    this.getPixelSource = options.getPixelSource ?? null;
  }

  /** Samples whatever the pointer is over. `pointer` is in NDC. */
  sample(pointer: THREE.Vector2, targets: readonly THREE.Object3D[]): EyedropperSample | null {
    this.raycaster.setFromCamera(pointer, this.camera);
    this.intersections.length = 0;
    this.raycaster.intersectObjects(targets as THREE.Object3D[], true, this.intersections);
    for (const hit of this.intersections) {
      const sample = this.sampleIntersection(hit);
      if (sample !== null) return sample;
    }
    return null;
  }

  /** The colour at one intersection, or null if the hit carries no material. */
  sampleIntersection(hit: THREE.Intersection): EyedropperSample | null {
    const material = resolveMaterial(hit);
    if (material === null) return null;

    const base = material.color;
    if (base === undefined) return null;
    scratchColor.copy(base);

    if (material.vertexColors === true) {
      const sampledVertex = sampleVertexColor(hit);
      if (sampledVertex !== null) scratchColor.multiply(sampledVertex);
    }

    const map = material.map ?? null;
    const uv = map?.channel === 1 ? hit.uv1 : hit.uv;
    if (map !== null && uv !== undefined) {
      const texel = this.sampleTexture(map, uv.x, uv.y);
      if (texel !== null) {
        // The texel is authored in the texture's own space and the material
        // colour is already in the working space, so the product is taken in
        // the working space and converted back at the end.
        texelColor.setRGB(texel[0], texel[1], texel[2], map.colorSpace);
        scratchColor.multiply(texelColor);
      }
    }

    scratchColor.getRGB(outColor, THREE.SRGBColorSpace);
    return {
      color: [outColor.r, outColor.g, outColor.b],
      object: hit.object,
      point: hit.point,
    };
  }

  /** Texel in the texture's own colour space, 0..1, or null if unreadable. */
  sampleTexture(texture: THREE.Texture, u: number, v: number): [number, number, number] | null {
    const source = this.pixelsOf(texture);
    if (source === null || source.width <= 0 || source.height <= 0) return null;

    texture.updateMatrix();
    scratchUv.set(u, v);
    texture.transformUv(scratchUv);
    const x = Math.min(source.width - 1, Math.max(0, Math.floor(scratchUv.x * source.width)));
    const y = Math.min(source.height - 1, Math.max(0, Math.floor(scratchUv.y * source.height)));

    const index = (y * source.width + x) * 4;
    return [
      (source.data[index] ?? 0) / 255,
      (source.data[index + 1] ?? 0) / 255,
      (source.data[index + 2] ?? 0) / 255,
    ];
  }

  dispose(): void {
    this.readbacks.clear();
  }

  private pixelsOf(texture: THREE.Texture): PaintPixelSource | null {
    const live = this.getPixelSource?.(texture) ?? null;
    if (live !== null) return live;

    const cached = this.readbacks.get(texture.uuid);
    if (cached !== undefined) return cached;

    const source = readBack(texture);
    this.readbacks.set(texture.uuid, source);
    return source;
  }
}

/** Interpolates the vertex tint actually underneath a ray hit. */
function sampleVertexColor(hit: THREE.Intersection): THREE.Color | null {
  const object = hit.object;
  const face = hit.face;
  if (!(object instanceof THREE.Mesh) || face === null || face === undefined) return null;
  const position = object.geometry.getAttribute("position");
  const color = object.geometry.getAttribute("color");
  if (position === undefined || color === undefined || color.itemSize < 3) return null;

  vertexA.fromBufferAttribute(position, face.a);
  vertexB.fromBufferAttribute(position, face.b);
  vertexC.fromBufferAttribute(position, face.c);
  localPoint.copy(hit.point);
  object.worldToLocal(localPoint);
  THREE.Triangle.getBarycoord(localPoint, vertexA, vertexB, vertexC, barycentric);
  if (!Number.isFinite(barycentric.x)) return null;

  vertexColor.setRGB(
    color.getX(face.a) * barycentric.x + color.getX(face.b) * barycentric.y + color.getX(face.c) * barycentric.z,
    color.getY(face.a) * barycentric.x + color.getY(face.b) * barycentric.y + color.getY(face.c) * barycentric.z,
    color.getZ(face.a) * barycentric.x + color.getZ(face.b) * barycentric.y + color.getZ(face.c) * barycentric.z,
  );
  return vertexColor;
}

/** A hit on a multi-material mesh names its material through the face. */
function resolveMaterial(hit: THREE.Intersection): MaterialLike | null {
  const object = hit.object;
  if (!(object instanceof THREE.Mesh)) return null;
  const material: unknown = object.material;
  if (Array.isArray(material)) {
    const index = hit.face?.materialIndex ?? 0;
    return (material[index] as MaterialLike | undefined) ?? null;
  }
  return (material as MaterialLike | null) ?? null;
}

/**
 * Pulls a texture's pixels into memory once. Data textures already hold theirs;
 * anything drawable is copied through a scratch canvas, which is the only way
 * to read an image back without a GPU round trip.
 */
function readBack(texture: THREE.Texture): PaintPixelSource | null {
  const image: unknown = texture.image;
  if (image === null || image === undefined) return null;

  if (typeof image === "object" && "data" in image) {
    const data = (image as { data: unknown }).data;
    const width = (image as { width?: unknown }).width;
    const height = (image as { height?: unknown }).height;
    if (
      (data instanceof Uint8ClampedArray || data instanceof Uint8Array) &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      return {
        width,
        height,
        data: data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data),
      };
    }
    return null;
  }

  if (typeof document === "undefined") return null;
  const width = (image as { width?: unknown }).width;
  const height = (image as { height?: unknown }).height;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return null;
  try {
    context.drawImage(image as CanvasImageSource, 0, 0);
    const pixels = context.getImageData(0, 0, width, height);
    return { width, height, data: pixels.data };
  } catch {
    // A cross-origin image taints the canvas. The material colour alone is a
    // better answer than a thrown exception in the middle of a match.
    return null;
  }
}
