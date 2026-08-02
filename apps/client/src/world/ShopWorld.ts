import * as THREE from "three/webgpu";

import { DisposalBag } from "../engine/DisposalBag";
import type { ForgeWorkspace } from "../forge/ForgeController";
import type { QualitySettings } from "../rendering/quality";
import { CuriosityShop, type CuriosityShopMap } from "./maps/CuriosityShop";
import { createShopEnvironment } from "./maps/lighting";
import {
  SHOP_MAX_X,
  SHOP_MAX_Z,
  SHOP_MIN_X,
  SHOP_MIN_Z,
  WALL_HEIGHT,
} from "./maps/zones";

/**
 * The volume a Mimic may be folded inside on this map. It reaches the walls and
 * the ceiling rather than stopping short of them, because mounting on a wall
 * and hanging from a fitting are both legal disguises (§7.15, §7.16). The floor
 * bound sits a hair above zero so nothing is posed inside the boards.
 */
export const SHOP_FORGE_WORKSPACE: ForgeWorkspace = {
  minX: SHOP_MIN_X,
  maxX: SHOP_MAX_X,
  minY: 0.02,
  maxY: WALL_HEIGHT,
  minZ: SHOP_MIN_Z,
  maxZ: SHOP_MAX_Z,
};

/**
 * The scene a round is played in: The Curiosity Shop and the environment that
 * lights it, and nothing else. It deliberately owns no camera, because during a
 * round the camera belongs to whichever system has the player, the Forge orbit,
 * the Inspector rig, or the survey view between phases.
 */
export class ShopWorld {
  readonly scene: THREE.Scene;
  readonly map: CuriosityShopMap;

  private readonly bag = new DisposalBag();

  constructor(renderer: THREE.WebGPURenderer, settings: QualitySettings) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08070a);
    this.scene.environment = this.bag.add(createShopEnvironment(renderer));
    this.scene.environmentIntensity = 0.55;

    const shop = new CuriosityShop();
    this.map = shop.build(settings);
    this.scene.add(this.map.root);
  }

  applyQuality(settings: QualitySettings): void {
    this.map.applyQuality(settings);
  }

  dispose(): void {
    this.map.dispose();
    this.scene.clear();
    this.bag.dispose();
  }
}
