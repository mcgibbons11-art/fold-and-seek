import * as THREE from "three/webgpu";

import {
  decodePaintLayer,
  encodePaintLayer,
  MAX_PAINT_STROKES,
  quantizePaintStroke,
  type PaintStrokeWire,
} from "@foldseek/shared";

import {
  DEFAULT_ATLAS_SIZE,
  PAINT_TARGET_COUNT,
  paintTileOf,
  paintTileTransform,
  type PaintTile,
} from "./paintTargets";

/**
 * A Mimic's body paint (MECCHA port, CLAUDE.md override 3).
 *
 * The layer owns two things that must never disagree: a log of brush stamps,
 * which is what travels on the wire, and an RGBA atlas, which is what the body
 * wears. Every pixel is produced by replaying the log, so a peer that receives
 * the log paints exactly the image its author painted. That is why the stamps
 * are rasterized here in integer software rather than through a canvas gradient:
 * `createRadialGradient` is free to differ between browsers, and a disguise that
 * looks different to the Inspector than to its owner is a fairness bug in a
 * hiding game.
 *
 * The atlas is the material's `map`, so an unpainted tile is not transparent: it
 * is filled with its part's swatch colour. Painting composites over that fill
 * and erasing composites the fill back, which is what makes an eraser return the
 * body to its material rather than to a hole.
 */

export interface PaintStroke {
  /** Index into the shared PAINT_TARGET_IDS order (segments, then panels). */
  readonly segmentId: number;
  /** Hit point in the target's own 0..1 UV square. */
  readonly uv: readonly [number, number];
  /** Brush radius as a fraction of that square. */
  readonly radius: number;
  /** sRGB in 0..1, the space the colour wheel and the atlas both work in. */
  readonly color: readonly [number, number, number];
  readonly opacity: number;
  /**
   * Material response painted with the colour, both 0..1. Omitted strokes take
   * the defaults, which are the dead-matt dielectric a plain paint dab should
   * be. Smoothness is stored, not roughness: it is what the slider means.
   */
  readonly metallic?: number;
  readonly smoothness?: number;
  readonly kind: "brush" | "eraser";
  /**
   * Sampled while the pointer was already down on this target. A continued
   * stamp is joined to the one before it, which is what keeps a fast drag a
   * line instead of a row of dots, on replay as much as on the painter's screen.
   */
  readonly continued?: boolean;
}

export interface PaintLayerOptions {
  readonly atlasSize?: number;
  /**
   * Where the atlas is uploaded from. Defaults to a canvas created on demand,
   * and is null under a test runner with no DOM: the pixel buffer and the whole
   * of the rasterizer work without one.
   */
  readonly canvas?: HTMLCanvasElement | null;
}

export interface PaintPixelSource {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Porcelain, the swatch a Mimic wears before anything is sampled (§17.3). */
const DEFAULT_BASE_COLOR: readonly [number, number, number] = [236, 226, 210];

/** Porcelain's own response, until the binder reads the real material. */
const DEFAULT_BASE_ROUGHNESS = 77;
const DEFAULT_BASE_METALNESS = 0;

/** A dab of paint with no material intent: matt, and not a metal. */
const DEFAULT_STROKE_METALLIC = 0;
const DEFAULT_STROKE_SMOOTHNESS = 0.35;

/** Stamp spacing along an interpolated drag, as a fraction of the brush radius. */
const STAMP_SPACING = 0.35;

/** Smallest brush the wire can carry, in UV units. */
const MIN_RADIUS_UV = 1 / 63;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function toWire(stroke: PaintStroke): PaintStrokeWire {
  return quantizePaintStroke({
    target: stroke.segmentId,
    u: stroke.uv[0],
    v: stroke.uv[1],
    radius: Math.max(stroke.radius, MIN_RADIUS_UV),
    color: [stroke.color[0], stroke.color[1], stroke.color[2]],
    opacity: stroke.opacity,
    metallic: stroke.metallic ?? DEFAULT_STROKE_METALLIC,
    smoothness: stroke.smoothness ?? DEFAULT_STROKE_SMOOTHNESS,
    erase: stroke.kind === "eraser",
    continued: stroke.continued === true,
  });
}

export class PaintLayer {
  readonly atlasSize: number;

  private readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  /**
   * The second atlas: green is roughness and blue is metalness, the packing
   * three reads for `roughnessMap.g` and `metalnessMap.b` (verified in
   * MaterialNode.js and the roughnessmap/metalnessmap shader chunks in 0.185).
   * One texture therefore feeds both slots. It is data, not colour, so it
   * carries no colour space and must never be tagged sRGB.
   */
  private readonly materialPixels: Uint8ClampedArray<ArrayBuffer>;
  private readonly strokes: PaintStrokeWire[] = [];
  private readonly tiles: readonly PaintTile[];
  /** sRGB bytes each tile is cleared to, one per paint target. */
  private readonly baseColors: Uint8Array;
  /** Roughness and metalness bytes each tile is cleared to, per paint target. */
  private readonly baseMaterials: Uint8Array;
  /** Last stamp on each target, so a continued stamp knows what to join to. */
  private readonly lastU: Float64Array;
  private readonly lastV: Float64Array;
  private readonly hasLast: Uint8Array;

  private readonly canvas: HTMLCanvasElement | null;
  private context: CanvasRenderingContext2D | null = null;
  private texture: THREE.CanvasTexture | null = null;
  private readonly targetTextures = new Map<number, THREE.Texture>();

  private readonly materialCanvas: HTMLCanvasElement | null;
  private materialContext: CanvasRenderingContext2D | null = null;
  private materialTexture: THREE.CanvasTexture | null = null;
  private readonly targetMaterialTextures = new Map<number, THREE.Texture>();

  private dirty = true;

  constructor(options: PaintLayerOptions = {}) {
    this.atlasSize = options.atlasSize ?? DEFAULT_ATLAS_SIZE;
    this.pixels = new Uint8ClampedArray(this.atlasSize * this.atlasSize * 4);
    this.materialPixels = new Uint8ClampedArray(this.atlasSize * this.atlasSize * 4);
    this.tiles = Array.from({ length: PAINT_TARGET_COUNT }, (_, index) =>
      paintTileOf(index, this.atlasSize),
    );
    this.baseColors = new Uint8Array(PAINT_TARGET_COUNT * 3);
    this.baseMaterials = new Uint8Array(PAINT_TARGET_COUNT * 2);
    this.lastU = new Float64Array(PAINT_TARGET_COUNT);
    this.lastV = new Float64Array(PAINT_TARGET_COUNT);
    this.hasLast = new Uint8Array(PAINT_TARGET_COUNT);

    for (let index = 0; index < PAINT_TARGET_COUNT; index++) {
      this.baseColors[index * 3] = DEFAULT_BASE_COLOR[0];
      this.baseColors[index * 3 + 1] = DEFAULT_BASE_COLOR[1];
      this.baseColors[index * 3 + 2] = DEFAULT_BASE_COLOR[2];
      this.baseMaterials[index * 2] = DEFAULT_BASE_ROUGHNESS;
      this.baseMaterials[index * 2 + 1] = DEFAULT_BASE_METALNESS;
    }

    const makeCanvas = (): HTMLCanvasElement | null => {
      if (typeof document === "undefined") return null;
      const canvas = document.createElement("canvas");
      canvas.width = this.atlasSize;
      canvas.height = this.atlasSize;
      return canvas;
    };
    this.canvas = options.canvas !== undefined ? options.canvas : makeCanvas();
    if (this.canvas !== null) {
      this.canvas.width = this.atlasSize;
      this.canvas.height = this.atlasSize;
    }
    // The material atlas always owns its canvas: it is never the one a caller
    // hands in, because a caller only ever supplies the visible one.
    this.materialCanvas = options.canvas === null ? null : makeCanvas();

    this.fillAllTiles();
  }

  get strokeCount(): number {
    return this.strokes.length;
  }

  /** The log itself, for a caller that wants to publish it without encoding. */
  get strokeLog(): readonly PaintStrokeWire[] {
    return this.strokes;
  }

  /**
   * Colour a target's tile is cleared to, in sRGB 0..1. This is the part's own
   * material colour, so changing a swatch reprints the tile and replays the
   * paint over the new base.
   */
  setBaseColor(targetIndex: number, color: readonly [number, number, number]): void {
    this.setBaseColors([[targetIndex, color]]);
  }

  /**
   * Batched form. Binding a whole body touches every target at once, and each
   * change costs a rebuild, so the caller that has them all should say so.
   */
  setBaseColors(
    entries: readonly (readonly [number, readonly [number, number, number]])[],
  ): void {
    let changed = false;
    for (const [targetIndex, color] of entries) {
      if (targetIndex < 0 || targetIndex >= PAINT_TARGET_COUNT) continue;
      const r = Math.round(clamp01(color[0]) * 255);
      const g = Math.round(clamp01(color[1]) * 255);
      const b = Math.round(clamp01(color[2]) * 255);
      if (
        this.baseColors[targetIndex * 3] === r &&
        this.baseColors[targetIndex * 3 + 1] === g &&
        this.baseColors[targetIndex * 3 + 2] === b
      ) {
        continue;
      }
      this.baseColors[targetIndex * 3] = r;
      this.baseColors[targetIndex * 3 + 1] = g;
      this.baseColors[targetIndex * 3 + 2] = b;
      changed = true;
    }
    if (changed) this.rebuild();
  }

  /**
   * Response an unpainted texel of a target reports, both 0..1 and expressed as
   * three reads them: roughness, not smoothness.
   *
   * This is the passthrough that keeps a swatch intact under an empty layer.
   * Both maps MULTIPLY their material scalar, so the binder sets those scalars
   * to one and the swatch's own values live here instead. An unpainted texel
   * therefore reproduces the swatch exactly, and a painted one replaces it.
   */
  setBaseMaterials(
    entries: readonly (readonly [number, number, number])[],
  ): void {
    let changed = false;
    for (const [targetIndex, roughness, metalness] of entries) {
      if (targetIndex < 0 || targetIndex >= PAINT_TARGET_COUNT) continue;
      const r = Math.round(clamp01(roughness) * 255);
      const m = Math.round(clamp01(metalness) * 255);
      if (
        this.baseMaterials[targetIndex * 2] === r &&
        this.baseMaterials[targetIndex * 2 + 1] === m
      ) {
        continue;
      }
      this.baseMaterials[targetIndex * 2] = r;
      this.baseMaterials[targetIndex * 2 + 1] = m;
      changed = true;
    }
    if (changed) this.rebuild();
  }

  applyStroke(stroke: PaintStroke): void {
    const wire = toWire(stroke);
    if (wire.target < 0 || wire.target >= PAINT_TARGET_COUNT) return;

    if (this.strokes.length >= MAX_PAINT_STROKES) {
      // The ceiling drops the oldest stamp rather than refusing the newest: a
      // brush that dies mid-drag reads as a broken tool. Dropping one changes
      // the image, so the atlas is rebuilt from the surviving log and the two
      // stay identical.
      this.strokes.splice(0, this.strokes.length - MAX_PAINT_STROKES + 1);
      this.strokes.push(wire);
      this.rebuild();
      return;
    }

    this.strokes.push(wire);
    this.rasterize(wire);
  }

  applyStrokes(batch: readonly PaintStroke[]): void {
    for (const stroke of batch) {
      this.applyStroke(stroke);
    }
  }

  /** Drops every stamp and returns the body to its materials. */
  clear(): void {
    this.strokes.length = 0;
    this.fillAllTiles();
  }

  toDataForWire(): string {
    return encodePaintLayer(this.strokes);
  }

  /** Replaces the whole layer with a peer's. Returns false on a bad payload. */
  fromWireData(payload: string): boolean {
    const decoded = decodePaintLayer(payload);
    if (!decoded.ok) return false;
    this.strokes.length = 0;
    for (const stroke of decoded.layer.strokes) {
      if (stroke.target < PAINT_TARGET_COUNT) this.strokes.push(stroke);
    }
    this.rebuild();
    return true;
  }

  /**
   * The atlas texture. Null only where there is no DOM to hold a canvas, which
   * is the test runner; painting itself works either way.
   */
  getTexture(): THREE.CanvasTexture | null {
    if (this.texture === null && this.canvas !== null) {
      const texture = new THREE.CanvasTexture(this.canvas);
      texture.name = "mimic_paint_atlas";
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      this.texture = texture;
      this.flush();
    }
    return this.texture;
  }

  /**
   * The material-response atlas, for `roughnessMap` and `metalnessMap` both.
   * Deliberately left in no colour space: three reads it as data, and tagging
   * it sRGB would put an inverse transfer curve through a roughness value.
   */
  getMaterialTexture(): THREE.CanvasTexture | null {
    if (this.materialTexture === null && this.materialCanvas !== null) {
      const texture = new THREE.CanvasTexture(this.materialCanvas);
      texture.name = "mimic_paint_material_atlas";
      texture.colorSpace = THREE.NoColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      this.materialTexture = texture;
      this.flush();
    }
    return this.materialTexture;
  }

  /**
   * A view of one target's tile, ready to hang on that part's material. Clones
   * share the atlas texture's source, so all twenty-seven views are one upload.
   */
  getTargetTexture(targetIndex: number): THREE.Texture | null {
    return this.tileView(this.getTexture(), targetIndex, this.targetTextures, "tile");
  }

  /** The same view onto the material atlas; serves roughness and metalness. */
  getTargetMaterialTexture(targetIndex: number): THREE.Texture | null {
    return this.tileView(
      this.getMaterialTexture(),
      targetIndex,
      this.targetMaterialTextures,
      "material_tile",
    );
  }

  private tileView(
    atlas: THREE.Texture | null,
    targetIndex: number,
    cache: Map<number, THREE.Texture>,
    label: string,
  ): THREE.Texture | null {
    if (atlas === null || targetIndex < 0 || targetIndex >= PAINT_TARGET_COUNT) return null;
    const existing = cache.get(targetIndex);
    if (existing !== undefined) return existing;

    const transform = paintTileTransform(targetIndex);
    const view = atlas.clone();
    view.name = `mimic_paint_${label}_${targetIndex}`;
    view.offset.set(transform.offsetU, transform.offsetV);
    view.repeat.set(transform.repeatU, transform.repeatV);
    view.needsUpdate = true;
    cache.set(targetIndex, view);
    return view;
  }

  /** Live pixels, for the eyedropper reading paint back off the body. */
  pixelSource(): PaintPixelSource {
    return { width: this.atlasSize, height: this.atlasSize, data: this.pixels };
  }

  materialPixelSource(): PaintPixelSource {
    return { width: this.atlasSize, height: this.atlasSize, data: this.materialPixels };
  }

  /** Roughness and metalness currently shown at a point, both 0..1. */
  readTargetMaterialPixel(
    targetIndex: number,
    u: number,
    v: number,
  ): [number, number] | null {
    const index = this.texelIndex(targetIndex, u, v);
    if (index === null) return null;
    return [(this.materialPixels[index + 1] ?? 0) / 255, (this.materialPixels[index + 2] ?? 0) / 255];
  }

  /** sRGB 0..1 currently shown at a point on a target. */
  readTargetPixel(
    targetIndex: number,
    u: number,
    v: number,
  ): [number, number, number] | null {
    const index = this.texelIndex(targetIndex, u, v);
    if (index === null) return null;
    return [
      (this.pixels[index] ?? 0) / 255,
      (this.pixels[index + 1] ?? 0) / 255,
      (this.pixels[index + 2] ?? 0) / 255,
    ];
  }

  /** Both atlases share one tile layout, so one lookup serves both. */
  private texelIndex(targetIndex: number, u: number, v: number): number | null {
    const tile = this.tiles[targetIndex];
    if (tile === undefined) return null;
    const x = Math.min(
      tile.x + tile.width - 1,
      Math.max(tile.x, Math.floor(tile.x + clamp01(u) * tile.width)),
    );
    const y = Math.min(
      tile.y + tile.height - 1,
      Math.max(tile.y, Math.floor(tile.y + (1 - clamp01(v)) * tile.height)),
    );
    return (y * this.atlasSize + x) * 4;
  }

  /**
   * Uploads the pixels if anything changed. Cheap to call every frame and a
   * no-op without a canvas.
   */
  flush(): void {
    if (!this.dirty) return;
    if (this.canvas !== null) {
      if (this.context === null) this.context = this.canvas.getContext("2d");
      this.context?.putImageData(
        new ImageData(this.pixels, this.atlasSize, this.atlasSize),
        0,
        0,
      );
    }
    if (this.materialCanvas !== null) {
      if (this.materialContext === null) {
        this.materialContext = this.materialCanvas.getContext("2d");
      }
      this.materialContext?.putImageData(
        new ImageData(this.materialPixels, this.atlasSize, this.atlasSize),
        0,
        0,
      );
    }
    if (this.canvas === null && this.materialCanvas === null) return;

    this.dirty = false;
    if (this.texture !== null) this.texture.needsUpdate = true;
    if (this.materialTexture !== null) this.materialTexture.needsUpdate = true;
    // The tile views are what the body actually wears, and the renderer decides
    // whether to re-upload from each texture's own version. Marking only the
    // atlas leaves every view holding the image it was first bound with, so the
    // paint would never reach the screen.
    for (const view of this.targetTextures.values()) {
      view.needsUpdate = true;
    }
    for (const view of this.targetMaterialTextures.values()) {
      view.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const view of this.targetTextures.values()) {
      view.dispose();
    }
    for (const view of this.targetMaterialTextures.values()) {
      view.dispose();
    }
    this.targetTextures.clear();
    this.targetMaterialTextures.clear();
    this.texture?.dispose();
    this.materialTexture?.dispose();
    this.texture = null;
    this.materialTexture = null;
    this.context = null;
    this.materialContext = null;
  }

  /** Repaints every tile from its base colour and replays the surviving log. */
  private rebuild(): void {
    this.fillAllTiles();
    for (const stroke of this.strokes) {
      this.rasterize(stroke);
    }
  }

  private fillAllTiles(): void {
    this.hasLast.fill(0);
    for (let index = 0; index < PAINT_TARGET_COUNT; index++) {
      this.fillTile(index);
    }
    this.dirty = true;
  }

  private fillTile(targetIndex: number): void {
    const tile = this.tiles[targetIndex];
    if (tile === undefined) return;
    const r = this.baseColors[targetIndex * 3] ?? 255;
    const g = this.baseColors[targetIndex * 3 + 1] ?? 255;
    const b = this.baseColors[targetIndex * 3 + 2] ?? 255;
    // Red is left at full: three reads only green and blue here, and an aoMap
    // bound to the same texture would take red as fully unoccluded.
    const roughness = this.baseMaterials[targetIndex * 2] ?? 255;
    const metalness = this.baseMaterials[targetIndex * 2 + 1] ?? 0;
    for (let y = tile.y; y < tile.y + tile.height; y++) {
      let index = (y * this.atlasSize + tile.x) * 4;
      for (let x = 0; x < tile.width; x++) {
        this.pixels[index] = r;
        this.pixels[index + 1] = g;
        this.pixels[index + 2] = b;
        this.pixels[index + 3] = 255;
        this.materialPixels[index] = 255;
        this.materialPixels[index + 1] = roughness;
        this.materialPixels[index + 2] = metalness;
        this.materialPixels[index + 3] = 255;
        index += 4;
      }
    }
  }

  private rasterize(stroke: PaintStrokeWire): void {
    const tile = this.tiles[stroke.target];
    if (tile === undefined) return;

    const alpha = Math.round(clamp01(stroke.opacity) * 255);
    if (alpha <= 0) {
      this.lastU[stroke.target] = stroke.u;
      this.lastV[stroke.target] = stroke.v;
      this.hasLast[stroke.target] = 1;
      return;
    }

    const radiusX = Math.max(stroke.radius * tile.width, 0.5);
    const radiusY = Math.max(stroke.radius * tile.height, 0.5);
    // Erasing is not a hole: it composites the part's own colour and its own
    // response back, so the body returns to its material rather than to nothing.
    const source: StampSource = stroke.erase
      ? {
          r: this.baseColors[stroke.target * 3] ?? 255,
          g: this.baseColors[stroke.target * 3 + 1] ?? 255,
          b: this.baseColors[stroke.target * 3 + 2] ?? 255,
          roughness: this.baseMaterials[stroke.target * 2] ?? 255,
          metalness: this.baseMaterials[stroke.target * 2 + 1] ?? 0,
        }
      : {
          r: Math.round(clamp01(stroke.color[0]) * 255),
          g: Math.round(clamp01(stroke.color[1]) * 255),
          b: Math.round(clamp01(stroke.color[2]) * 255),
          // three's map is roughness; the painter's slider is smoothness.
          roughness: Math.round((1 - clamp01(stroke.smoothness)) * 255),
          metalness: Math.round(clamp01(stroke.metallic) * 255),
        };

    if (stroke.continued && this.hasLast[stroke.target] === 1) {
      const fromU = this.lastU[stroke.target] ?? stroke.u;
      const fromV = this.lastV[stroke.target] ?? stroke.v;
      let deltaU = stroke.u - fromU;
      // On a shell, u = 0 and u = 1 are the same line, so a drag across the
      // seam takes the short way round rather than back across the whole body.
      if (tile.wrapU && Math.abs(deltaU) > 0.5) deltaU -= Math.sign(deltaU);
      const deltaV = stroke.v - fromV;

      const spanX = Math.abs(deltaU) * tile.width;
      const spanY = Math.abs(deltaV) * tile.height;
      const distance = Math.hypot(spanX, spanY);
      const spacing = Math.max(Math.min(radiusX, radiusY) * STAMP_SPACING, 0.75);
      const steps = Math.min(Math.ceil(distance / spacing), 4_096);
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        this.stamp(tile, fromU + deltaU * t, fromV + deltaV * t, radiusX, radiusY, source, alpha);
      }
    } else {
      this.stamp(tile, stroke.u, stroke.v, radiusX, radiusY, source, alpha);
    }

    this.lastU[stroke.target] = stroke.u;
    this.lastV[stroke.target] = stroke.v;
    this.hasLast[stroke.target] = 1;
    this.dirty = true;
  }

  /**
   * One soft round stamp, composited in integer source-over. The falloff is
   * `(1 - d^2)^2` over the brush radius, which is smooth at the rim without the
   * hard edge a linear ramp leaves.
   */
  private stamp(
    tile: PaintTile,
    u: number,
    v: number,
    radiusX: number,
    radiusY: number,
    source: StampSource,
    alpha: number,
  ): void {
    const wrappedU = tile.wrapU ? u - Math.floor(u) : clamp01(u);
    const centerX = tile.x + wrappedU * tile.width;
    const centerY = tile.y + (1 - clamp01(v)) * tile.height;

    const minY = Math.max(tile.y, Math.floor(centerY - radiusY));
    const maxY = Math.min(tile.y + tile.height - 1, Math.ceil(centerY + radiusY));
    const minX = Math.floor(centerX - radiusX);
    const maxX = Math.ceil(centerX + radiusX);

    for (let y = minY; y <= maxY; y++) {
      const dy = (y + 0.5 - centerY) / radiusY;
      const dy2 = dy * dy;
      if (dy2 >= 1) continue;
      const rowStart = y * this.atlasSize;
      for (let x = minX; x <= maxX; x++) {
        const dx = (x + 0.5 - centerX) / radiusX;
        const distance = dx * dx + dy2;
        if (distance >= 1) continue;

        let column = x;
        if (column < tile.x || column >= tile.x + tile.width) {
          if (!tile.wrapU) continue;
          column = tile.x + (((column - tile.x) % tile.width) + tile.width) % tile.width;
        }

        const falloff = (1 - distance) * (1 - distance);
        const coverage = Math.round(alpha * falloff);
        if (coverage <= 0) continue;

        // Both atlases take the same coverage in the same pass, so colour and
        // response can never drift apart at the soft rim of a stroke.
        const index = (rowStart + column) * 4;
        this.pixels[index] = blend(source.r, this.pixels[index] ?? 0, coverage);
        this.pixels[index + 1] = blend(source.g, this.pixels[index + 1] ?? 0, coverage);
        this.pixels[index + 2] = blend(source.b, this.pixels[index + 2] ?? 0, coverage);
        this.materialPixels[index + 1] = blend(
          source.roughness,
          this.materialPixels[index + 1] ?? 0,
          coverage,
        );
        this.materialPixels[index + 2] = blend(
          source.metalness,
          this.materialPixels[index + 2] ?? 0,
          coverage,
        );
      }
    }
  }
}

/** One stamp's colour and material response, in bytes ready to composite. */
interface StampSource {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly roughness: number;
  readonly metalness: number;
}

/** Integer source-over, so the same log produces the same bytes everywhere. */
function blend(source: number, destination: number, coverage: number): number {
  return Math.round((source * coverage + destination * (255 - coverage)) / 255);
}
