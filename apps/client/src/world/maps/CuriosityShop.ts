import type { ObjectRegistry } from "@foldseek/game-sim";
import * as THREE from "three/webgpu";
import { DisposalBag } from "../../engine/DisposalBag";
import type { QualitySettings } from "../../rendering/quality";
import { ShopLighting } from "./lighting";
import { SHOP_PLACEMENTS, type PropPlacement } from "./placements";
import { buildArchitecture, PROP_BUILDERS, type PropContext } from "./props";
import { PropBatcher, type PropLayer } from "./props/batch";
import { GeometryCache } from "./props/geometry";
import { ShopMaterials } from "./props/materials";
import type { NavData } from "../../inspector/navData";
import { NAV_DATA } from "./nav";
import { buildMapObjects, buildObjectRegistry, CURIOSITY_SHOP_MAP_ID, type MapObjectEntry } from "./registry";
import { ZONES, type MapZone } from "./zones";

/**
 * The Curiosity Shop, the first map (§10.2), built as a procedural blockout to
 * the target art direction rather than as placeholder primitives (§17.6).
 *
 * The whole map is one Group the host can add to any scene. Geometry comes
 * from the authored placement manifest, so the visual room and the room the
 * simulation reasons about cannot drift apart.
 */

export interface CuriosityShopStats {
  readonly props: number;
  readonly parts: number;
  readonly heroMeshes: number;
  readonly instancedMeshes: number;
  readonly mergedMeshes: number;
  /** Meshes submitted for the map before frustum culling. */
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly practicals: number;
  readonly shadowedLights: number;
  /** Lamps drawing a stand-in pool because the backend could not light them. */
  readonly lightPools: number;
  readonly inspectableObjects: number;
}

export interface CuriosityShopMap {
  readonly mapId: string;
  readonly root: THREE.Group;
  readonly zones: readonly MapZone[];
  readonly objects: readonly MapObjectEntry[];
  readonly registry: ObjectRegistry;
  readonly nav: NavData;
  readonly stats: CuriosityShopStats;
  applyQuality(settings: QualitySettings): void;
  dispose(): void;
}

function layerFor(placement: PropPlacement): PropLayer {
  if (placement.hero) {
    return "hero";
  }
  return placement.inspectable ? "standard" : "background";
}

export class CuriosityShop {
  private readonly bag = new DisposalBag();
  private built = false;
  private root: THREE.Group | null = null;
  private materials: ShopMaterials | null = null;
  private lighting: ShopLighting | null = null;
  private batcher: PropBatcher | null = null;

  /**
   * Builds the map once. Calling it twice would duplicate every GPU resource,
   * so a second call is a programming error rather than a rebuild.
   */
  build(quality: QualitySettings): CuriosityShopMap {
    if (this.built) {
      throw new Error("CuriosityShop: already built; construct a new instance for a second map");
    }
    this.built = true;

    const root = new THREE.Group();
    root.name = "curiosity-shop";
    this.root = root;

    const geometry = new GeometryCache(this.bag);
    const materials = new ShopMaterials(this.bag);
    const batcher = new PropBatcher(root, this.bag);
    this.materials = materials;
    this.batcher = batcher;

    const context: PropContext = { geometry, materials, batcher };
    buildArchitecture(context);

    for (const placement of SHOP_PLACEMENTS) {
      const builder = PROP_BUILDERS[placement.variant];
      batcher.begin(
        placement.objectId,
        placement.position,
        placement.rotationY,
        placement.hero,
        1,
        layerFor(placement),
      );
      builder(context, placement);
      batcher.end();
    }

    const batch = batcher.finalize();
    const lighting = new ShopLighting(root, quality);
    this.lighting = lighting;

    const objects = buildMapObjects();
    const map: CuriosityShopMap = {
      mapId: CURIOSITY_SHOP_MAP_ID,
      root,
      zones: ZONES,
      objects,
      registry: buildObjectRegistry(),
      nav: NAV_DATA,
      stats: {
        props: SHOP_PLACEMENTS.length,
        parts: batch.parts,
        heroMeshes: batch.heroMeshes,
        instancedMeshes: batch.instancedMeshes,
        mergedMeshes: batch.mergedMeshes,
        drawCalls: batch.drawCalls,
        triangles: batch.triangles,
        geometries: geometry.size,
        practicals: lighting.stats.practicals,
        shadowedLights: lighting.stats.shadowedLights,
        lightPools: lighting.stats.lightPools,
        inspectableObjects: objects.filter((entry) => entry.accusationPolicy === "allowed").length,
      },
      applyQuality: (settings) => {
        this.applyQuality(settings);
      },
      dispose: () => {
        this.dispose();
      },
    };

    this.applyQuality(quality);
    return map;
  }

  private applyQuality(settings: QualitySettings): void {
    this.materials?.setAnisotropy(settings.maxAnisotropy);
    this.lighting?.applyQuality(settings);

    const batcher = this.batcher;
    if (batcher !== null) {
      // Micro-detail and background dressing are the first thing a weak tier
      // gives up; nothing a player can accuse lives in that layer.
      batcher.layers.background.visible = settings.clutterDensity >= 0.4;
    }
  }

  private dispose(): void {
    this.lighting?.dispose();
    this.lighting = null;
    this.root?.clear();
    this.root = null;
    this.materials = null;
    this.batcher = null;
    this.bag.dispose();
  }
}
