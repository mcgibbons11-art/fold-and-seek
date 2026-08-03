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
  /**
   * How much the stroke glows, 0..1, in the stroke's own colour. Zero by
   * default, so a stroke that says nothing about emissive costs nothing: the
   * emissive atlas is not even allocated until the first glowing stamp.
   */
  readonly emissive?: number;
  readonly kind: "brush" | "eraser";
  /**
   * Sampled while the pointer was already down on this target. A continued
   * stamp is joined to the one before it, which is what keeps a fast drag a
   * line instead of a row of dots, on replay as much as on the painter's screen.
   */
  readonly continued?: boolean;
}

/**
 * One gesture's worth of stamps, as the Forge's history holds it: what the drag
 * appended, and what the stroke ceiling dropped off the front to make room.
 */
export interface PaintStrokeBatch {
  readonly added: readonly PaintStrokeWire[];
  readonly evicted: readonly PaintStrokeWire[];
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

/** Cumulative paint raster, rebuild, and canvas-upload counters. */
export interface PaintUploadStats {
  readonly flushes: number;
  readonly rectangles: number;
  readonly pixels: number;
  readonly targets: number;
  /** Stroke rasterizations, including target-local history replay. */
  readonly rasterizedStrokes: number;
  /** CPU time spent preparing canvas uploads, accumulated in milliseconds. */
  readonly flushCpuMs: number;
  /** Full or target-local replay operations. */
  readonly rebuilds: number;
  /** Number of tiles reset across those rebuilds (27 means one full atlas). */
  readonly rebuiltTargets: number;
}

/** Mutable sink for allocation-free diagnostics polling. */
export type PaintUploadStatsSink = { -readonly [Key in keyof PaintUploadStats]: PaintUploadStats[Key] };

interface PaintUploadRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Porcelain, the swatch a Mimic wears before anything is sampled (§17.3). */
const DEFAULT_BASE_COLOR: readonly [number, number, number] = [236, 226, 210];

/** Porcelain's own response, until the binder reads the real material. */
const DEFAULT_BASE_ROUGHNESS = 77;
const DEFAULT_BASE_METALNESS = 0;

/** A dab of paint with no material intent: matt, not a metal, and not lit. */
const DEFAULT_STROKE_METALLIC = 0;
const DEFAULT_STROKE_SMOOTHNESS = 0.35;
const DEFAULT_STROKE_EMISSIVE = 0;

/** Stamp spacing along an interpolated drag, as a fraction of the brush radius. */
const STAMP_SPACING = 0.35;

/**
 * Paint has a fixed wire budget. Pruning one stamp whenever that budget is
 * full forces a replay of the surviving target on every rendered frame, which
 * turns a sustained spray into an ever-growing CPU spike. Retire a useful
 * runway at once instead: the image still agrees exactly with the published
 * log, while the expensive replay is amortized across the next 96 dabs.
 */
const STROKE_EVICTION_RUNWAY = 96;

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
    emissive: stroke.emissive ?? DEFAULT_STROKE_EMISSIVE,
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
  /**
   * The third atlas: the glow, in sRGB, allocated only once a stroke actually
   * asks for one.
   *
   * It holds a colour rather than a mask because a painted marking glows in the
   * colour it was painted in, which is what MECCHA's panel does. Three
   * multiplies `emissiveMap` by the material's own `emissive` colour, so a
   * single-channel mask could only ever glow in one colour for the whole body.
   * The material atlas cannot lend its spare red channel either: red is held at
   * full so an aoMap bound to the same texture reads unoccluded, and one channel
   * could not carry a colour in any case.
   *
   * A full atlas is four megabytes, which is why it waits: a body with no
   * glowing paint on it never pays for one.
   */
  private emissivePixels: Uint8ClampedArray<ArrayBuffer> | null = null;
  private readonly strokes: PaintStrokeWire[] = [];
  private readonly tiles: readonly PaintTile[];
  /** sRGB bytes each tile is cleared to, one per paint target. */
  private readonly baseColors: Uint8Array;
  /** Roughness and metalness bytes each tile is cleared to, per paint target. */
  private readonly baseMaterials: Uint8Array;
  /** sRGB glow each tile is cleared to, so a self-lit swatch survives an empty layer. */
  private readonly baseEmissives: Uint8Array;
  /** Last stamp on each target, so a continued stamp knows what to join to. */
  private readonly lastU: Float64Array;
  private readonly lastV: Float64Array;
  private readonly hasLast: Uint8Array;

  /** True under a test runner told to work without a DOM. */
  private readonly headless: boolean;
  private readonly canvas: HTMLCanvasElement | null;
  private context: CanvasRenderingContext2D | null = null;
  private texture: THREE.CanvasTexture | null = null;
  private readonly targetTextures = new Map<number, THREE.Texture>();

  private readonly materialCanvas: HTMLCanvasElement | null;
  private materialContext: CanvasRenderingContext2D | null = null;
  private materialTexture: THREE.CanvasTexture | null = null;
  private readonly targetMaterialTextures = new Map<number, THREE.Texture>();

  private emissiveCanvas: HTMLCanvasElement | null = null;
  private emissiveContext: CanvasRenderingContext2D | null = null;
  private emissiveTexture: THREE.CanvasTexture | null = null;
  private readonly targetEmissiveTextures = new Map<number, THREE.Texture>();

  /** Reused ImageData wrappers; their typed arrays remain live as paint changes. */
  private colorImage: ImageData | null = null;
  private materialImage: ImageData | null = null;
  private emissiveImage: ImageData | null = null;

  /** One bit per atlas tile. A dab normally dirties exactly one of them. */
  private readonly dirtyTargets = new Uint8Array(PAINT_TARGET_COUNT);
  private uploadFlushes = 0;
  private uploadRectangles = 0;
  private uploadPixels = 0;
  private uploadTargets = 0;
  private rasterizedStrokes = 0;
  private flushCpuMs = 0;
  private rebuilds = 0;
  private rebuiltTargets = 0;

  /** Open undo batch, collecting what to take back when the drag ends. */
  private batch: { added: PaintStrokeWire[]; evicted: PaintStrokeWire[] } | null = null;

  /**
   * Monotonic authoring revision. Stroke count cannot serve this purpose: an
   * undo, clear, or capped log can change the painted image without increasing
   * its length. The round publisher watches this cheap integer and only
   * serializes the layer when the image actually changed.
   */
  private changeRevision = 0;

  /** Encoding 768 stamps is not a per-frame dirty check. Cache it by revision. */
  private wireCacheRevision = -1;
  private wireCache = "";

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
    this.baseEmissives = new Uint8Array(PAINT_TARGET_COUNT * 3);
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

    this.headless = options.canvas === null;
    this.canvas = options.canvas !== undefined ? options.canvas : this.makeAtlasCanvas();
    if (this.canvas !== null) {
      this.canvas.width = this.atlasSize;
      this.canvas.height = this.atlasSize;
    }
    // The material atlas always owns its canvas: it is never the one a caller
    // hands in, because a caller only ever supplies the visible one.
    this.materialCanvas = this.headless ? null : this.makeAtlasCanvas();

    this.fillAllTiles();
  }

  get strokeCount(): number {
    return this.strokes.length;
  }

  get revision(): number {
    return this.changeRevision;
  }

  /**
   * True once this layer has carried a glowing stroke, which is when the
   * emissive atlas exists and a material may bind it.
   *
   * Deliberately monotonic. Erasing the last glowing stroke leaves the atlas
   * bound and printing its base fill, which is exactly the passthrough an
   * unbound material would have shown, so nothing is gained by unbinding and a
   * material that flickered between two shader variants would cost a recompile
   * each way.
   */
  get hasEmissive(): boolean {
    return this.emissivePixels !== null;
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
    const changedTargets: number[] = [];
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
      changedTargets.push(targetIndex);
    }
    this.rebuildTargets(changedTargets);
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
    const changedTargets: number[] = [];
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
      changedTargets.push(targetIndex);
    }
    this.rebuildTargets(changedTargets);
  }

  /**
   * Glow an unpainted texel of a target reports, in sRGB 0..1. The same
   * passthrough the other two base setters provide: the binder moves the part's
   * own emissive in here and sets the material's emissive colour to white, so
   * an empty layer leaves a self-lit swatch looking exactly as it did.
   */
  setBaseEmissives(
    entries: readonly (readonly [number, readonly [number, number, number]])[],
  ): void {
    const changedTargets: number[] = [];
    for (const [targetIndex, emissive] of entries) {
      if (targetIndex < 0 || targetIndex >= PAINT_TARGET_COUNT) continue;
      const r = Math.round(clamp01(emissive[0]) * 255);
      const g = Math.round(clamp01(emissive[1]) * 255);
      const b = Math.round(clamp01(emissive[2]) * 255);
      if (
        this.baseEmissives[targetIndex * 3] === r &&
        this.baseEmissives[targetIndex * 3 + 1] === g &&
        this.baseEmissives[targetIndex * 3 + 2] === b
      ) {
        continue;
      }
      this.baseEmissives[targetIndex * 3] = r;
      this.baseEmissives[targetIndex * 3 + 1] = g;
      this.baseEmissives[targetIndex * 3 + 2] = b;
      changedTargets.push(targetIndex);
    }
    if (this.emissivePixels !== null) this.rebuildTargets(changedTargets);
  }

  applyStroke(stroke: PaintStroke): void {
    const wire = toWire(stroke);
    if (wire.target < 0 || wire.target >= PAINT_TARGET_COUNT) return;

    // The first glowing stamp is what buys the emissive atlas. Allocating it
    // replays the whole log into it, because a matt stroke already on the body
    // has to have put out the swatch's own glow underneath it.
    if (wire.emissive > 0 && this.emissivePixels === null) {
      this.allocateEmissiveAtlas();
    }

    if (this.strokes.length >= MAX_PAINT_STROKES) {
      // The ceiling drops the oldest stamp rather than refusing the newest: a
      // brush that dies mid-drag reads as a broken tool. Dropping one changes
      // the image, so the atlas is rebuilt from the surviving log and the two
      // stay identical.
      const evicted = this.strokes.splice(
        0,
        Math.min(this.strokes.length, STROKE_EVICTION_RUNWAY),
      );
      this.strokes.push(wire);
      this.batch?.evicted.push(...evicted);
      this.batch?.added.push(wire);
      this.changeRevision += 1;
      // Only tiles represented in the retired runway (plus the new stamp) can
      // change. Replaying those avoids all 27 targets while producing pixels
      // byte-identical to a full replay of the surviving wire log.
      this.rebuildTargets(this.targetsOf([...evicted, wire]));
      return;
    }

    this.strokes.push(wire);
    this.batch?.added.push(wire);
    this.changeRevision += 1;
    this.rasterize(wire);
  }

  applyStrokes(batch: readonly PaintStroke[]): void {
    for (const stroke of batch) {
      this.applyStroke(stroke);
    }
  }

  /**
   * Opens an undo batch. Every stamp applied until `endStrokeBatch` belongs to
   * one entry in the Forge's history, which is what makes a drag one undo
   * rather than the eighty stamps it rasterized.
   */
  beginStrokeBatch(): void {
    this.batch = { added: [], evicted: [] };
  }

  /** Closes the batch, returning what to hand the history, or null if nothing was painted. */
  endStrokeBatch(): PaintStrokeBatch | null {
    const batch = this.batch;
    this.batch = null;
    if (batch === null || batch.added.length === 0) return null;
    return { added: batch.added, evicted: batch.evicted };
  }

  /**
   * Takes a batch back off the log and reprints from what survives.
   *
   * The batch is always the newest paint in the log, because the history is
   * last in, first out and nothing else appends while it holds one. Finding
   * otherwise means the log and the history have diverged, which would silently
   * erase somebody else's strokes, so it throws instead.
   */
  revertStrokeBatch(batch: PaintStrokeBatch): void {
    const start = this.strokes.length - batch.added.length;
    if (start < 0) {
      throw new Error("Paint undo asked for more strokes than the layer holds");
    }
    for (let i = 0; i < batch.added.length; i++) {
      if (this.strokes[start + i] !== batch.added[i]) {
        throw new Error("Paint undo does not match the end of the stroke log");
      }
    }
    this.strokes.length = start;
    // Strokes the ceiling dropped to make room for this batch go back where
    // they were, so undoing a stamp painted at the ceiling restores the image
    // the painter had rather than one missing its oldest marks.
    if (batch.evicted.length > 0) this.strokes.unshift(...batch.evicted);
    this.changeRevision += 1;
    this.rebuildTargets(this.targetsOf([...batch.added, ...batch.evicted]));
  }

  /**
   * Replays a reverted batch. Re-appending the same stamps to the same log
   * evicts the same strokes again, so a redo needs no record of its own.
   */
  reapplyStrokeBatch(batch: PaintStrokeBatch): void {
    if (batch.evicted.length > 0) {
      // Redo must retire the same runway the original gesture retired. Doing
      // it one stamp at a time would reintroduce the ceiling replay cliff and
      // would not reconstruct the painted image the batch recorded.
      this.strokes.splice(0, Math.min(this.strokes.length, batch.evicted.length));
    }
    for (const stroke of batch.added) {
      if (stroke.emissive > 0 && this.emissivePixels === null) this.allocateEmissiveAtlas();
      if (this.strokes.length >= MAX_PAINT_STROKES) {
        this.strokes.splice(0, Math.min(this.strokes.length, STROKE_EVICTION_RUNWAY));
      }
      this.strokes.push(stroke);
    }
    if (batch.added.length > 0) this.changeRevision += 1;
    this.rebuildTargets(this.targetsOf([...batch.added, ...batch.evicted]));
  }

  /** Drops every stamp and returns the body to its materials. */
  clear(): void {
    if (this.strokes.length === 0) return;
    this.strokes.length = 0;
    this.batch = null;
    this.changeRevision += 1;
    this.fillAllTiles();
  }

  /** The whole log, copied, for a command that has to be able to put it back. */
  captureStrokeLog(): readonly PaintStrokeWire[] {
    return [...this.strokes];
  }

  /** Replaces the log wholesale, for undoing a clear. */
  restoreStrokeLog(strokes: readonly PaintStrokeWire[]): void {
    this.strokes.length = 0;
    for (const stroke of strokes) {
      if (stroke.emissive > 0 && this.emissivePixels === null) this.allocateEmissiveAtlas();
      this.strokes.push(stroke);
    }
    this.changeRevision += 1;
    this.rebuild();
  }

  toDataForWire(): string {
    if (this.wireCacheRevision !== this.changeRevision) {
      this.wireCache = encodePaintLayer(this.strokes);
      this.wireCacheRevision = this.changeRevision;
    }
    return this.wireCache;
  }

  /** Canvas-copy counters used by the performance HUD and regression tests. */
  get uploadStats(): PaintUploadStats {
    return {
      flushes: this.uploadFlushes,
      rectangles: this.uploadRectangles,
      pixels: this.uploadPixels,
      targets: this.uploadTargets,
      rasterizedStrokes: this.rasterizedStrokes,
      flushCpuMs: this.flushCpuMs,
      rebuilds: this.rebuilds,
      rebuiltTargets: this.rebuiltTargets,
    };
  }

  /** Writes counters into a caller-owned object, so a live overlay allocates nothing. */
  readUploadStats(out: PaintUploadStatsSink): PaintUploadStatsSink {
    out.flushes = this.uploadFlushes;
    out.rectangles = this.uploadRectangles;
    out.pixels = this.uploadPixels;
    out.targets = this.uploadTargets;
    out.rasterizedStrokes = this.rasterizedStrokes;
    out.flushCpuMs = this.flushCpuMs;
    out.rebuilds = this.rebuilds;
    out.rebuiltTargets = this.rebuiltTargets;
    return out;
  }

  /** Replaces the whole layer with a peer's. Returns false on a bad payload. */
  fromWireData(payload: string): boolean {
    const decoded = decodePaintLayer(payload);
    if (!decoded.ok) return false;
    this.strokes.length = 0;
    for (const stroke of decoded.layer.strokes) {
      if (stroke.target >= PAINT_TARGET_COUNT) continue;
      if (stroke.emissive > 0 && this.emissivePixels === null) this.allocateEmissiveAtlas();
      this.strokes.push(stroke);
    }
    this.changeRevision += 1;
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

  /**
   * The glow atlas, for `emissiveMap`. Null until a stroke has asked for one,
   * which is what keeps an unlit body from paying four megabytes for a channel
   * it does not use. It is a colour map, so it is tagged sRGB: three converts it
   * to linear before multiplying the material's emissive.
   */
  getEmissiveTexture(): THREE.CanvasTexture | null {
    if (this.emissiveTexture === null && this.emissiveCanvas !== null) {
      const texture = new THREE.CanvasTexture(this.emissiveCanvas);
      texture.name = "mimic_paint_emissive_atlas";
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      this.emissiveTexture = texture;
      this.dirty = true;
      this.flush();
    }
    return this.emissiveTexture;
  }

  /** One target's tile of the glow atlas. */
  getTargetEmissiveTexture(targetIndex: number): THREE.Texture | null {
    return this.tileView(
      this.getEmissiveTexture(),
      targetIndex,
      this.targetEmissiveTextures,
      "emissive_tile",
    );
  }

  /** Live glow pixels, for a test or a tool reading the atlas back. */
  emissivePixelSource(): PaintPixelSource | null {
    if (this.emissivePixels === null) return null;
    return { width: this.atlasSize, height: this.atlasSize, data: this.emissivePixels };
  }

  /** sRGB glow currently shown at a point, or null where the layer has none. */
  readTargetEmissivePixel(
    targetIndex: number,
    u: number,
    v: number,
  ): [number, number, number] | null {
    const pixels = this.emissivePixels;
    if (pixels === null) return null;
    const index = this.texelIndex(targetIndex, u, v);
    if (index === null) return null;
    return [
      (pixels[index] ?? 0) / 255,
      (pixels[index + 1] ?? 0) / 255,
      (pixels[index + 2] ?? 0) / 255,
    ];
  }

  private makeAtlasCanvas(): HTMLCanvasElement | null {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = this.atlasSize;
    canvas.height = this.atlasSize;
    return canvas;
  }

  /**
   * Brings the glow atlas into existence and reprints everything into it. The
   * whole log is replayed rather than only the stroke that triggered this: the
   * matt paint already on the body has to go on covering the swatch's own glow.
   */
  private allocateEmissiveAtlas(): void {
    if (this.emissivePixels !== null) return;
    this.emissivePixels = new Uint8ClampedArray(this.atlasSize * this.atlasSize * 4);
    this.emissiveCanvas = this.headless ? null : this.makeAtlasCanvas();
    this.rebuild();
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
    const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
    const targets: number[] = [];
    for (let target = 0; target < this.dirtyTargets.length; target++) {
      if (this.dirtyTargets[target] === 1) targets.push(target);
    }
    const rectangles = this.uploadRegions(targets);

    if (this.canvas !== null) {
      if (this.context === null) this.context = this.canvas.getContext("2d");
      if (this.context !== null && this.colorImage === null && typeof ImageData !== "undefined") {
        this.colorImage = new ImageData(this.pixels, this.atlasSize, this.atlasSize);
      }
      if (this.colorImage !== null) this.copyRegions(this.context, this.colorImage, rectangles);
    }
    if (this.materialCanvas !== null) {
      if (this.materialContext === null) {
        this.materialContext = this.materialCanvas.getContext("2d");
      }
      if (
        this.materialContext !== null &&
        this.materialImage === null &&
        typeof ImageData !== "undefined"
      ) {
        this.materialImage = new ImageData(this.materialPixels, this.atlasSize, this.atlasSize);
      }
      if (this.materialImage !== null) {
        this.copyRegions(this.materialContext, this.materialImage, rectangles);
      }
    }
    const emissive = this.emissivePixels;
    if (this.emissiveCanvas !== null && emissive !== null) {
      if (this.emissiveContext === null) {
        this.emissiveContext = this.emissiveCanvas.getContext("2d");
      }
      if (
        this.emissiveContext !== null &&
        this.emissiveImage === null &&
        typeof ImageData !== "undefined"
      ) {
        this.emissiveImage = new ImageData(emissive, this.atlasSize, this.atlasSize);
      }
      if (this.emissiveImage !== null) {
        this.copyRegions(this.emissiveContext, this.emissiveImage, rectangles);
      }
    }

    this.dirty = false;
    this.dirtyTargets.fill(0);
    this.uploadFlushes += 1;
    this.uploadRectangles += rectangles.length;
    this.uploadTargets += targets.length;
    for (const rectangle of rectangles) this.uploadPixels += rectangle.width * rectangle.height;
    // The parent atlas is only a clone source. Once tile views exist it is not
    // worn by a material, so incrementing it too would schedule a redundant
    // upload alongside the dirty view.
    if (this.texture !== null && this.targetTextures.size === 0) this.texture.needsUpdate = true;
    if (this.materialTexture !== null && this.targetMaterialTextures.size === 0) {
      this.materialTexture.needsUpdate = true;
    }
    if (this.emissiveTexture !== null && this.targetEmissiveTextures.size === 0) {
      this.emissiveTexture.needsUpdate = true;
    }
    // The tile views are what the body actually wears, and the renderer decides
    // whether to re-upload from each texture's own version. Marking only the
    // atlas leaves every view holding the image it was first bound with, so the
    // paint would never reach the screen.
    for (const target of targets) {
      const color = this.targetTextures.get(target);
      const material = this.targetMaterialTextures.get(target);
      const glow = this.targetEmissiveTextures.get(target);
      if (color !== undefined) color.needsUpdate = true;
      if (material !== undefined) material.needsUpdate = true;
      if (glow !== undefined) glow.needsUpdate = true;
    }
    const finishedAt = typeof performance === "undefined" ? Date.now() : performance.now();
    this.flushCpuMs += Math.max(0, finishedAt - startedAt);
  }

  /**
   * Adjacent dirty tiles are cheaper as one canvas copy; sparse tiles remain
   * separate so a dab on a hand does not copy the empty atlas between it and a
   * panel. The threshold avoids trading a tiny pixel saving for many JS calls.
   */
  private uploadRegions(targets: readonly number[]): PaintUploadRegion[] {
    if (targets.length === 0) return [];
    const tiles = targets.flatMap((target) => {
      const tile = this.tiles[target];
      return tile === undefined
        ? []
        : [{ x: tile.x, y: tile.y, width: tile.width, height: tile.height }];
    });
    if (tiles.length <= 1) return tiles;

    let minX = this.atlasSize;
    let minY = this.atlasSize;
    let maxX = 0;
    let maxY = 0;
    let tilePixels = 0;
    for (const tile of tiles) {
      minX = Math.min(minX, tile.x);
      minY = Math.min(minY, tile.y);
      maxX = Math.max(maxX, tile.x + tile.width);
      maxY = Math.max(maxY, tile.y + tile.height);
      tilePixels += tile.width * tile.height;
    }
    const union = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    return union.width * union.height <= tilePixels * 1.5 || tiles.length > 6 ? [union] : tiles;
  }

  private copyRegions(
    context: CanvasRenderingContext2D | null,
    image: ImageData,
    regions: readonly PaintUploadRegion[],
  ): void {
    if (context === null) return;
    for (const region of regions) {
      context.putImageData(
        image,
        0,
        0,
        region.x,
        region.y,
        region.width,
        region.height,
      );
    }
  }

  dispose(): void {
    for (const view of this.targetTextures.values()) {
      view.dispose();
    }
    for (const view of this.targetMaterialTextures.values()) {
      view.dispose();
    }
    for (const view of this.targetEmissiveTextures.values()) {
      view.dispose();
    }
    this.targetTextures.clear();
    this.targetMaterialTextures.clear();
    this.targetEmissiveTextures.clear();
    this.texture?.dispose();
    this.materialTexture?.dispose();
    this.emissiveTexture?.dispose();
    this.texture = null;
    this.materialTexture = null;
    this.emissiveTexture = null;
    this.context = null;
    this.materialContext = null;
    this.emissiveContext = null;
    this.colorImage = null;
    this.materialImage = null;
    this.emissiveImage = null;
  }

  /** Repaints every tile from its base colour and replays the surviving log. */
  private rebuild(): void {
    this.rebuilds += 1;
    this.rebuiltTargets += PAINT_TARGET_COUNT;
    this.fillAllTiles();
    for (const stroke of this.strokes) {
      this.rasterize(stroke);
    }
  }

  /** Replays only the tiles whose bases or surviving logs changed. */
  private rebuildTargets(targets: readonly number[]): void {
    if (targets.length === 0) return;
    const wanted = new Uint8Array(PAINT_TARGET_COUNT);
    let targetCount = 0;
    for (const target of targets) {
      if (target < 0 || target >= PAINT_TARGET_COUNT || wanted[target] === 1) continue;
      wanted[target] = 1;
      targetCount += 1;
      this.hasLast[target] = 0;
      this.fillTile(target);
    }
    if (targetCount === 0) return;
    this.rebuilds += 1;
    this.rebuiltTargets += targetCount;
    for (const stroke of this.strokes) {
      if (wanted[stroke.target] === 1) this.rasterize(stroke);
    }
  }

  private targetsOf(strokes: readonly PaintStrokeWire[]): number[] {
    const seen = new Uint8Array(PAINT_TARGET_COUNT);
    const targets: number[] = [];
    for (const stroke of strokes) {
      if (stroke.target >= PAINT_TARGET_COUNT || seen[stroke.target] === 1) continue;
      seen[stroke.target] = 1;
      targets.push(stroke.target);
    }
    return targets;
  }

  private fillAllTiles(): void {
    this.hasLast.fill(0);
    for (let index = 0; index < PAINT_TARGET_COUNT; index++) {
      this.fillTile(index);
    }
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
    const emissive = this.emissivePixels;
    const er = this.baseEmissives[targetIndex * 3] ?? 0;
    const eg = this.baseEmissives[targetIndex * 3 + 1] ?? 0;
    const eb = this.baseEmissives[targetIndex * 3 + 2] ?? 0;
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
        if (emissive !== null) {
          emissive[index] = er;
          emissive[index + 1] = eg;
          emissive[index + 2] = eb;
          emissive[index + 3] = 255;
        }
        index += 4;
      }
    }
    this.markTargetDirty(targetIndex);
  }

  private rasterize(stroke: PaintStrokeWire): void {
    const tile = this.tiles[stroke.target];
    if (tile === undefined) return;
    this.rasterizedStrokes += 1;

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
          emissiveR: this.baseEmissives[stroke.target * 3] ?? 0,
          emissiveG: this.baseEmissives[stroke.target * 3 + 1] ?? 0,
          emissiveB: this.baseEmissives[stroke.target * 3 + 2] ?? 0,
        }
      : {
          r: Math.round(clamp01(stroke.color[0]) * 255),
          g: Math.round(clamp01(stroke.color[1]) * 255),
          b: Math.round(clamp01(stroke.color[2]) * 255),
          // three's map is roughness; the painter's slider is smoothness.
          roughness: Math.round((1 - clamp01(stroke.smoothness)) * 255),
          metalness: Math.round(clamp01(stroke.metallic) * 255),
          // The glow is the stroke's own colour turned down by the emissive
          // amount, so a stroke lights up in the colour it was painted in and a
          // matt one lays black over whatever was glowing underneath it.
          emissiveR: Math.round(clamp01(stroke.color[0]) * clamp01(stroke.emissive) * 255),
          emissiveG: Math.round(clamp01(stroke.color[1]) * clamp01(stroke.emissive) * 255),
          emissiveB: Math.round(clamp01(stroke.color[2]) * clamp01(stroke.emissive) * 255),
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
    this.markTargetDirty(stroke.target);
  }

  private markTargetDirty(targetIndex: number): void {
    if (targetIndex < 0 || targetIndex >= PAINT_TARGET_COUNT) return;
    this.dirtyTargets[targetIndex] = 1;
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
        const emissive = this.emissivePixels;
        if (emissive !== null) {
          emissive[index] = blend(source.emissiveR, emissive[index] ?? 0, coverage);
          emissive[index + 1] = blend(source.emissiveG, emissive[index + 1] ?? 0, coverage);
          emissive[index + 2] = blend(source.emissiveB, emissive[index + 2] ?? 0, coverage);
        }
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
  readonly emissiveR: number;
  readonly emissiveG: number;
  readonly emissiveB: number;
}

/** Integer source-over, so the same log produces the same bytes everywhere. */
function blend(source: number, destination: number, coverage: number): number {
  return Math.round((source * coverage + destination * (255 - coverage)) / 255);
}
