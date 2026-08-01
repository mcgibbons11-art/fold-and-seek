import * as THREE from "three/webgpu";
import type { PropPlacement } from "../placements";
import { swatchRole, type PropContext } from "./context";
import {
  chamferedBox,
  chamferedSlab,
  curtainPanel,
  extrudeProfile,
  lathe,
  quantize,
  roundedRectShape,
  superellipseColumn,
} from "./geometry";
import { GLASS_PANE_MATERIAL } from "./materials";

/**
 * Furniture and fixtures: the objects that define zone silhouettes and most of
 * the shop's blocked volume. Sizes are authored per placement through
 * `size`, so one builder covers a whole family of widths without breaking
 * instancing: the geometry cache keys on the resolved dimension.
 */

function sized(base: string, ...values: readonly number[]): string {
  return `${base}#${values.map((value) => value.toFixed(3)).join("x")}`;
}

/** Swatch roles: 0 = upholstery, 1 = frame wood. */
export function buildArmchair(ctx: PropContext, placement: PropPlacement): void {
  const cloth = ctx.materials.get(swatchRole(placement, 0, "velvet_burgundy_01"));
  const wood = ctx.materials.get(swatchRole(placement, 1, "walnut_dark_01"));
  const b = ctx.batcher;

  const leg = ctx.geometry.get("chair.leg", () => new THREE.CylinderGeometry(0.033, 0.045, 0.23, 8));
  for (const dx of [-0.35, 0.35]) {
    for (const dz of [-0.33, 0.33]) {
      b.part(leg, wood, { x: dx, y: 0.115, z: dz });
    }
  }
  b.part(ctx.geometry.get("armchair.skirt", () => chamferedBox(0.9, 0.19, 0.88, 0.032)), cloth, { y: 0.325 });
  b.part(ctx.geometry.get("armchair.cushion", () => chamferedBox(0.82, 0.2, 0.8, 0.062)), cloth, { y: 0.51, z: 0.01 });
  b.part(ctx.geometry.get("armchair.back", () => chamferedBox(0.9, 0.85, 0.18, 0.05)), cloth, {
    y: 0.89,
    z: -0.36,
    rx: 0.13,
  });
  b.part(ctx.geometry.get("armchair.backCushion", () => chamferedBox(0.7, 0.62, 0.14, 0.05)), cloth, {
    y: 0.83,
    z: -0.24,
    rx: 0.16,
  });

  const arm = ctx.geometry.get("armchair.arm", () => chamferedBox(0.16, 0.27, 0.84, 0.04));
  const roll = ctx.geometry.get("armchair.roll", () => new THREE.CapsuleGeometry(0.08, 0.62, 3, 10));
  for (const side of [-1, 1]) {
    b.part(arm, cloth, { x: side * 0.41, y: 0.68, z: -0.02 });
    b.part(roll, cloth, { x: side * 0.41, y: 0.82, z: -0.02, rx: Math.PI / 2 });
  }
}

/** Swatch roles: 0 = top cloth, 1 = legs. */
export function buildFootstool(ctx: PropContext, placement: PropPlacement): void {
  const cloth = ctx.materials.get(swatchRole(placement, 0, "velvet_burgundy_01"));
  const wood = ctx.materials.get(swatchRole(placement, 1, "walnut_mid_02"));
  const b = ctx.batcher;

  const leg = ctx.geometry.get("footstool.leg", () => new THREE.CylinderGeometry(0.026, 0.035, 0.18, 8));
  for (const dx of [-0.19, 0.19]) {
    for (const dz of [-0.14, 0.14]) {
      b.part(leg, wood, { x: dx, y: 0.09, z: dz });
    }
  }
  b.part(ctx.geometry.get("footstool.top", () => chamferedBox(0.53, 0.17, 0.43, 0.05)), cloth, { y: 0.265 });
}

/** Swatch roles: 0 = seat, 1 = legs. `size` is the seat height. */
export function buildStool(ctx: PropContext, placement: PropPlacement): void {
  const seatMaterial = ctx.materials.get(swatchRole(placement, 0, "walnut_mid_02"));
  const legMaterial = ctx.materials.get(swatchRole(placement, 1, "iron_dark_03"));
  const height = quantize(placement.size ?? 0.48, 0.06);
  const b = ctx.batcher;

  const seat = ctx.geometry.get("stool.seat", () =>
    lathe(
      [
        [0, 0],
        [0.17, 0],
        [0.182, 0.014],
        [0.178, 0.04],
        [0.15, 0.047],
        [0, 0.047],
      ],
      20,
    ),
  );
  b.part(seat, seatMaterial, { y: height });

  const leg = ctx.geometry.get(sized("stool.leg", height), () =>
    new THREE.CylinderGeometry(0.016, 0.022, height, 7),
  );
  const ring = ctx.geometry.get("stool.ring", () => new THREE.TorusGeometry(0.14, 0.009, 5, 16));
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2 + 0.4;
    b.part(leg, legMaterial, {
      x: Math.sin(angle) * 0.11,
      y: height / 2,
      z: Math.cos(angle) * 0.11,
      rx: Math.cos(angle) * 0.09,
      rz: -Math.sin(angle) * 0.09,
    });
  }
  b.part(ring, legMaterial, { y: height * 0.34, rx: -Math.PI / 2 });
}

/** Swatch roles: 0 = frame, 1 = seat pad. */
export function buildLadderbackChair(ctx: PropContext, placement: PropPlacement): void {
  const wood = ctx.materials.get(swatchRole(placement, 0, "oak_pale_03"));
  const pad = ctx.materials.get(swatchRole(placement, 1, "linen_cream_02"));
  const b = ctx.batcher;

  const frontLeg = ctx.geometry.get("chairLb.frontLeg", () => new THREE.CylinderGeometry(0.019, 0.023, 0.45, 7));
  const backLeg = ctx.geometry.get("chairLb.backLeg", () => new THREE.CylinderGeometry(0.019, 0.024, 0.95, 7));
  for (const dx of [-0.19, 0.19]) {
    b.part(frontLeg, wood, { x: dx, y: 0.225, z: 0.17 });
    b.part(backLeg, wood, { x: dx, y: 0.475, z: -0.17, rx: -0.04 });
  }
  b.part(ctx.geometry.get("chairLb.seat", () => chamferedSlab(0.42, 0.045, 0.4, 0.012)), wood, { y: 0.47 });
  b.part(ctx.geometry.get("chairLb.pad", () => chamferedSlab(0.36, 0.035, 0.34, 0.014)), pad, { y: 0.51 });

  const slat = ctx.geometry.get("chairLb.slat", () => chamferedBox(0.36, 0.075, 0.022, 0.008));
  for (const y of [0.63, 0.76, 0.89]) {
    b.part(slat, wood, { y, z: -0.185, rx: -0.04 });
  }
  const stretcher = ctx.geometry.get("chairLb.stretcher", () => new THREE.CylinderGeometry(0.012, 0.012, 0.38, 6));
  b.part(stretcher, wood, { y: 0.17, z: 0.17, rz: Math.PI / 2 });
  b.part(stretcher, wood, { y: 0.17, z: -0.17, rz: Math.PI / 2 });
}

/** Swatch roles: 0 = wood, 1 = inlay metal. */
export function buildSideTable(ctx: PropContext, placement: PropPlacement): void {
  const wood = ctx.materials.get(swatchRole(placement, 0, "walnut_dark_01"));
  const metal = ctx.materials.get(swatchRole(placement, 1, "brass_tarnished_01"));
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("sideTable.pedestal", () =>
      lathe(
        [
          [0.27, 0],
          [0.28, 0.02],
          [0.25, 0.052],
          [0.1, 0.095],
          [0.072, 0.18],
          [0.08, 0.32],
          [0.06, 0.44],
          [0.09, 0.51],
          [0.078, 0.57],
          [0.056, 0.61],
        ],
        22,
      ),
    ),
    wood,
  );
  b.part(
    ctx.geometry.get("sideTable.top", () =>
      lathe(
        [
          [0, 0.61],
          [0.3, 0.61],
          [0.338, 0.626],
          [0.338, 0.652],
          [0.3, 0.67],
          [0, 0.67],
        ],
        26,
      ),
    ),
    wood,
  );
  b.part(ctx.geometry.get("sideTable.inlay", () => new THREE.TorusGeometry(0.29, 0.006, 6, 30)), metal, {
    y: 0.673,
    rx: -Math.PI / 2,
  });
}

/** Nested display plinth. Swatch roles: 0 = body, 1 = cap. `size` is height. */
export function buildPlinth(ctx: PropContext, placement: PropPlacement): void {
  const body = ctx.materials.get(swatchRole(placement, 0, "paint_cream_01"));
  const cap = ctx.materials.get(swatchRole(placement, 1, "walnut_dark_01"));
  const height = quantize(placement.size ?? 0.7, 0.1);
  const width = 0.34;
  const b = ctx.batcher;

  b.part(ctx.geometry.get(sized("plinth.foot", width), () => chamferedSlab(width + 0.06, 0.045, width + 0.06, 0.01)), cap, {
    y: 0.022,
  });
  b.part(
    ctx.geometry.get(sized("plinth.shaft", width, height), () =>
      superellipseColumn(width, width, height - 0.09, 4.2, 0.016),
    ),
    body,
    { y: 0.045 },
  );
  b.part(ctx.geometry.get(sized("plinth.cap", width), () => chamferedSlab(width + 0.05, 0.045, width + 0.05, 0.01)), cap, {
    y: height - 0.022,
  });
}

/**
 * Glass display cabinet, the vocabulary of zone E. Swatch roles: 0 = carcass,
 * 1 = shelf. `size` is the cabinet width.
 */
export function buildDisplayCabinet(ctx: PropContext, placement: PropPlacement): void {
  const wood = ctx.materials.get(swatchRole(placement, 0, "walnut_dark_01"));
  const shelfMaterial = ctx.materials.get(swatchRole(placement, 1, "oak_pale_03"));
  const glass = ctx.materials.get(GLASS_PANE_MATERIAL);
  const width = quantize(placement.size ?? 1.9, 0.35);
  const depth = 0.55;
  const height = 1.95;
  const b = ctx.batcher;

  b.part(ctx.geometry.get(sized("cabinet.base", width, depth), () => chamferedSlab(width, 0.16, depth, 0.016)), wood, {
    y: 0.08,
  });
  b.part(
    ctx.geometry.get(sized("cabinet.crown", width, depth), () => chamferedSlab(width + 0.06, 0.09, depth + 0.06, 0.014)),
    wood,
    { y: height - 0.045 },
  );

  const post = ctx.geometry.get(sized("cabinet.post", height), () => chamferedBox(0.06, height - 0.25, 0.06, 0.012));
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      b.part(post, wood, { x: (dx * (width - 0.06)) / 2, y: height / 2 + 0.04, z: (dz * (depth - 0.06)) / 2 });
    }
  }

  const shelf = ctx.geometry.get(sized("cabinet.shelf", width, depth), () =>
    chamferedSlab(width - 0.1, 0.026, depth - 0.1, 0.008),
  );
  for (const y of [0.68, 1.15, 1.6]) {
    b.part(shelf, shelfMaterial, { y }, { shadow: false });
  }

  const frontGlass = ctx.geometry.get(sized("cabinet.glass.front", width, height), () =>
    new THREE.PlaneGeometry(width - 0.1, height - 0.32),
  );
  const sideGlass = ctx.geometry.get(sized("cabinet.glass.side", depth, height), () =>
    new THREE.PlaneGeometry(depth - 0.1, height - 0.32),
  );
  b.part(frontGlass, glass, { y: height / 2 + 0.04, z: depth / 2 }, { shadow: false, receive: false });
  b.part(frontGlass, glass, { y: height / 2 + 0.04, z: -depth / 2 }, { shadow: false, receive: false });
  for (const dx of [-1, 1]) {
    b.part(
      sideGlass,
      glass,
      { x: (dx * width) / 2, y: height / 2 + 0.04, ry: Math.PI / 2 },
      { shadow: false, receive: false },
    );
  }
}

/** Wall-hung shelf. Swatch roles: 0 = plank, 1 = brackets. `size` is width. */
export function buildWallShelf(ctx: PropContext, placement: PropPlacement): void {
  const wood = ctx.materials.get(swatchRole(placement, 0, "walnut_mid_02"));
  const metal = ctx.materials.get(swatchRole(placement, 1, "iron_dark_03"));
  const width = quantize(placement.size ?? 1.1, 0.1);
  const b = ctx.batcher;

  b.part(ctx.geometry.get(sized("wallShelf.plank", width), () => chamferedSlab(width, 0.035, 0.26, 0.01)), wood, {});
  const bracket = ctx.geometry.get("wallShelf.bracket", () => chamferedBox(0.02, 0.16, 0.2, 0.006));
  for (const dx of [-1, 1]) {
    b.part(bracket, metal, { x: (dx * (width - 0.24)) / 2, y: -0.09, z: -0.02 }, { shadow: false });
  }
}

/** Low open bookcase. Swatch roles: 0 = carcass, 1 = back panel. */
export function buildLowShelf(ctx: PropContext, placement: PropPlacement): void {
  const wood = ctx.materials.get(swatchRole(placement, 0, "walnut_mid_02"));
  const back = ctx.materials.get(swatchRole(placement, 1, "paint_verdigris_03"));
  const width = quantize(placement.size ?? 1.1, 0.15);
  const height = 1.12;
  const depth = 0.34;
  const b = ctx.batcher;

  const side = ctx.geometry.get(sized("lowShelf.side", height, depth), () => chamferedBox(0.04, height, depth, 0.01));
  for (const dx of [-1, 1]) {
    b.part(side, wood, { x: (dx * (width - 0.04)) / 2, y: height / 2 });
  }
  const shelf = ctx.geometry.get(sized("lowShelf.shelf", width, depth), () =>
    chamferedSlab(width - 0.08, 0.032, depth - 0.02, 0.008),
  );
  for (const y of [0.06, 0.42, 0.78, height - 0.016]) {
    b.part(shelf, wood, { y });
  }
  b.part(
    ctx.geometry.get(sized("lowShelf.back", width, height), () => chamferedBox(width - 0.08, height - 0.1, 0.016, 0.006)),
    back,
    { y: height / 2, z: -depth / 2 + 0.012 },
    { shadow: false },
  );
}

/** Workshop steel shelving. Swatch roles: 0 = frame, 1 = shelf boards. */
export function buildShelvingUnit(ctx: PropContext, placement: PropPlacement): void {
  const metal = ctx.materials.get(swatchRole(placement, 0, "iron_dark_03"));
  const board = ctx.materials.get(swatchRole(placement, 1, "oak_pale_03"));
  const width = quantize(placement.size ?? 2.0, 0.25);
  const height = 2.3;
  const depth = 0.5;
  const b = ctx.batcher;

  const upright = ctx.geometry.get(sized("shelving.upright", height), () => chamferedBox(0.05, height, 0.05, 0.01));
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      b.part(upright, metal, { x: (dx * (width - 0.05)) / 2, y: height / 2, z: (dz * (depth - 0.05)) / 2 });
    }
  }
  const shelf = ctx.geometry.get(sized("shelving.shelf", width, depth), () =>
    chamferedSlab(width - 0.06, 0.04, depth, 0.01),
  );
  for (const y of [0.24, 0.82, 1.4, 1.98]) {
    b.part(shelf, board, { y });
  }
}

/** Collector's counter. Swatch roles: 0 = body, 1 = top, 2 = kick rail. */
export function buildCounter(ctx: PropContext, placement: PropPlacement): void {
  const body = ctx.materials.get(swatchRole(placement, 0, "walnut_dark_01"));
  const top = ctx.materials.get(swatchRole(placement, 1, "marble_cream_01"));
  const rail = ctx.materials.get(swatchRole(placement, 2, "brass_tarnished_01"));
  const width = quantize(placement.size ?? 3.0, 0.2);
  const depth = 0.8;
  const height = 1.05;
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get(sized("counter.body", width, depth), () => chamferedBox(width, height - 0.14, depth - 0.06, 0.02)),
    body,
    { y: (height - 0.14) / 2 + 0.1 },
  );
  b.part(ctx.geometry.get(sized("counter.kick", width, depth), () => chamferedSlab(width - 0.12, 0.1, depth - 0.16, 0.01)), body, {
    y: 0.05,
  });
  b.part(ctx.geometry.get(sized("counter.top", width, depth), () => chamferedSlab(width + 0.08, 0.06, depth, 0.014)), top, {
    y: height - 0.03,
  });

  const pilaster = ctx.geometry.get("counter.pilaster", () => chamferedBox(0.1, 0.8, 0.06, 0.014));
  for (const fraction of [-0.42, 0, 0.42]) {
    b.part(pilaster, body, { x: fraction * width, y: 0.52, z: (depth - 0.06) / 2 }, { shadow: false });
  }
  b.part(ctx.geometry.get("counter.rail", () => new THREE.CylinderGeometry(0.018, 0.018, width - 0.2, 8)), rail, {
    y: 0.16,
    z: depth / 2 + 0.04,
    rz: Math.PI / 2,
  });
}

/** Cabinet of small drawers behind the counter. Swatch roles: 0 = carcass, 1 = drawer fronts, 2 = knobs. */
export function buildBackCabinet(ctx: PropContext, placement: PropPlacement): void {
  const carcass = ctx.materials.get(swatchRole(placement, 0, "walnut_dark_01"));
  const drawer = ctx.materials.get(swatchRole(placement, 1, "oak_pale_03"));
  const knobMaterial = ctx.materials.get(swatchRole(placement, 2, "brass_tarnished_01"));
  const width = quantize(placement.size ?? 3.4, 0.2);
  const height = 2.1;
  const depth = 0.42;
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get(sized("backCab.carcass", width, height, depth), () => chamferedBox(width, height, depth, 0.02)),
    carcass,
    { y: height / 2 },
  );
  b.part(
    ctx.geometry.get(sized("backCab.cornice", width, depth), () => chamferedSlab(width + 0.08, 0.08, depth + 0.08, 0.014)),
    carcass,
    { y: height + 0.04 },
  );

  const columns = Math.max(Math.round(width / 0.42), 3);
  const rows = 5;
  const drawerWidth = (width - 0.1) / columns - 0.03;
  const drawerHeight = (height - 0.28) / rows - 0.03;
  const front = ctx.geometry.get(sized("backCab.drawer", drawerWidth, drawerHeight), () =>
    chamferedBox(drawerWidth, drawerHeight, 0.03, 0.008),
  );
  const knob = ctx.geometry.get("backCab.knob", () => new THREE.SphereGeometry(0.018, 8, 6));
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const x = -width / 2 + 0.05 + (drawerWidth + 0.03) * (column + 0.5);
      const y = 0.14 + (drawerHeight + 0.03) * (row + 0.5);
      b.part(front, drawer, { x, y, z: depth / 2 + 0.012 }, { shadow: false });
      b.part(knob, knobMaterial, { x, y, z: depth / 2 + 0.04 }, { shadow: false });
    }
  }
}

/** Workshop bench with a vice. Swatch roles: 0 = top, 1 = frame, 2 = vice metal. */
export function buildWorkbench(ctx: PropContext, placement: PropPlacement): void {
  const top = ctx.materials.get(swatchRole(placement, 0, "oak_pale_03"));
  const frame = ctx.materials.get(swatchRole(placement, 1, "walnut_mid_02"));
  const metal = ctx.materials.get(swatchRole(placement, 2, "iron_dark_03"));
  const width = quantize(placement.size ?? 2.4, 0.2);
  const depth = 0.9;
  const height = 0.92;
  const b = ctx.batcher;

  b.part(ctx.geometry.get(sized("bench.top", width, depth), () => chamferedSlab(width, 0.085, depth, 0.016)), top, {
    y: height - 0.042,
  });
  const leg = ctx.geometry.get(sized("bench.leg", height), () => chamferedBox(0.11, height - 0.09, 0.11, 0.014));
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      b.part(leg, frame, {
        x: (dx * (width - 0.24)) / 2,
        y: (height - 0.09) / 2,
        z: (dz * (depth - 0.22)) / 2,
      });
    }
  }
  b.part(
    ctx.geometry.get(sized("bench.apron", width, depth), () => chamferedBox(width - 0.3, 0.16, depth - 0.3, 0.012)),
    frame,
    { y: height - 0.22 },
    { shadow: false },
  );
  b.part(
    ctx.geometry.get(sized("bench.lowerShelf", width, depth), () => chamferedSlab(width - 0.32, 0.03, depth - 0.34, 0.008)),
    frame,
    { y: 0.22 },
    { shadow: false },
  );
  b.part(ctx.geometry.get("bench.vice", () => chamferedBox(0.24, 0.16, 0.14, 0.016)), metal, {
    x: -width / 2 + 0.16,
    y: height - 0.14,
    z: depth / 2 - 0.02,
  });
  b.part(ctx.geometry.get("bench.viceScrew", () => new THREE.CylinderGeometry(0.017, 0.017, 0.22, 8)), metal, {
    x: -width / 2 + 0.16,
    y: height - 0.14,
    z: depth / 2 + 0.09,
    rx: Math.PI / 2,
  });
}

/** Packing crate. Swatch roles: 0 = boards, 1 = corner straps. `size` is the edge length. */
export function buildCrate(ctx: PropContext, placement: PropPlacement): void {
  const wood = ctx.materials.get(swatchRole(placement, 0, "oak_pale_03"));
  const strap = ctx.materials.get(swatchRole(placement, 1, "iron_dark_03"));
  const edge = quantize(placement.size ?? 0.62, 0.08);
  const b = ctx.batcher;

  b.part(ctx.geometry.get(sized("crate.body", edge), () => chamferedBox(edge, edge * 0.86, edge, 0.018)), wood, {
    y: (edge * 0.86) / 2,
  });
  const board = ctx.geometry.get(sized("crate.board", edge), () => chamferedBox(edge + 0.02, 0.07, 0.022, 0.006));
  for (const y of [edge * 0.2, edge * 0.66]) {
    b.part(board, wood, { y, z: edge / 2 }, { shadow: false });
    b.part(board, wood, { y, z: -edge / 2 }, { shadow: false });
    b.part(board, wood, { x: edge / 2, y, ry: Math.PI / 2 }, { shadow: false });
    b.part(board, wood, { x: -edge / 2, y, ry: Math.PI / 2 }, { shadow: false });
  }
  const corner = ctx.geometry.get(sized("crate.corner", edge), () => chamferedBox(0.03, edge * 0.86, 0.03, 0.006));
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      b.part(corner, strap, { x: (dx * edge) / 2, y: (edge * 0.86) / 2, z: (dz * edge) / 2 }, { shadow: false });
    }
  }
}

/** Swatch roles: 0 = body, 1 = rim. */
export function buildUmbrellaStand(ctx: PropContext, placement: PropPlacement): void {
  const body = ctx.materials.get(swatchRole(placement, 0, "copper_patina_04"));
  const rim = ctx.materials.get(swatchRole(placement, 1, "brass_aged_02"));
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get("umbrella.body", () =>
      lathe(
        [
          [0, 0],
          [0.16, 0],
          [0.168, 0.02],
          [0.15, 0.12],
          [0.155, 0.44],
          [0.168, 0.56],
          [0.162, 0.585],
          [0.142, 0.575],
          [0.138, 0.06],
          [0, 0.05],
        ],
        20,
      ),
    ),
    body,
  );
  b.part(ctx.geometry.get("umbrella.rim", () => new THREE.TorusGeometry(0.163, 0.011, 6, 22)), rim, { y: 0.585 });

  // Two umbrellas leaning in the stand: the canopy is a tapered lathe so the
  // silhouette reads even from across the nook.
  const shaft = ctx.geometry.get("umbrella.shaft", () => new THREE.CylinderGeometry(0.012, 0.012, 0.9, 6));
  const canopy = ctx.geometry.get("umbrella.canopy", () =>
    lathe(
      [
        [0, 0],
        [0.05, 0.06],
        [0.062, 0.2],
        [0.03, 0.36],
        [0, 0.4],
      ],
      12,
    ),
  );
  const wool = ctx.materials.get("wool_midnight_03");
  const velvet = ctx.materials.get("velvet_burgundy_01");
  b.part(shaft, rim, { x: 0.04, y: 0.6, z: 0.02, rz: -0.13 });
  b.part(canopy, wool, { x: 0.11, y: 0.86, z: 0.03, rz: -0.13 });
  b.part(shaft, rim, { x: -0.05, y: 0.62, z: -0.03, rz: 0.1, rx: 0.06 });
  b.part(canopy, velvet, { x: -0.11, y: 0.9, z: -0.06, rz: 0.1, rx: 0.06 });
}

/** Swatch roles: 0 = field, 1 = border. `size` is the long edge. */
export function buildRug(ctx: PropContext, placement: PropPlacement): void {
  const field = ctx.materials.get(swatchRole(placement, 0, "wool_midnight_03"));
  const border = ctx.materials.get(swatchRole(placement, 1, "velvet_burgundy_01"));
  const long = quantize(placement.size ?? 3.6, 0.2);
  const short = long * 0.72;
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get(sized("rug.field", long), () =>
      extrudeProfile(roundedRectShape(long, short, 0.16), 0.014, { bevel: 0.004, curveSegments: 6 }).rotateX(
        -Math.PI / 2,
      ),
    ),
    border,
    {},
    { shadow: false },
  );
  b.part(
    ctx.geometry.get(sized("rug.inner", long), () =>
      extrudeProfile(roundedRectShape(long - 0.34, short - 0.34, 0.12), 0.008, {
        bevel: 0.003,
        curveSegments: 6,
      }).rotateX(-Math.PI / 2),
    ),
    field,
    { y: 0.009 },
    { shadow: false },
  );
}

/** Swatch roles: 0 = rails, 1 = rungs. */
export function buildLadder(ctx: PropContext, placement: PropPlacement): void {
  const rail = ctx.materials.get(swatchRole(placement, 0, "oak_pale_03"));
  const rung = ctx.materials.get(swatchRole(placement, 1, "walnut_mid_02"));
  const height = quantize(placement.size ?? 2.2, 0.2);
  const b = ctx.batcher;

  const railGeometry = ctx.geometry.get(sized("ladder.rail", height), () => chamferedBox(0.06, height, 0.035, 0.01));
  for (const dx of [-0.22, 0.22]) {
    b.part(railGeometry, rail, { x: dx, y: height / 2, rz: -Math.sign(dx) * 0.03 });
  }
  const rungGeometry = ctx.geometry.get("ladder.rung", () => new THREE.CylinderGeometry(0.017, 0.017, 0.46, 7));
  const steps = Math.floor(height / 0.32);
  for (let i = 1; i <= steps; i += 1) {
    b.part(rungGeometry, rung, { y: i * 0.32, rz: Math.PI / 2 }, { shadow: false });
  }
}

/** Swatch roles: 0 = cloth, 1 = pole. `size` is the drop height. */
export function buildCurtain(ctx: PropContext, placement: PropPlacement): void {
  const cloth = ctx.materials.get(swatchRole(placement, 0, "velvet_burgundy_01"));
  const pole = ctx.materials.get(swatchRole(placement, 1, "brass_aged_02"));
  const height = quantize(placement.size ?? 2.6, 0.2);
  const width = 0.62;
  const b = ctx.batcher;

  b.part(
    ctx.geometry.get(sized("curtain.panel", width, height), () => curtainPanel(width, height, 3, 0.13)),
    cloth,
    {},
    { shadow: false },
  );
  b.part(
    ctx.geometry.get(sized("curtain.heading", width), () => new THREE.CylinderGeometry(0.022, 0.022, width + 0.12, 8)),
    pole,
    { y: height + 0.04, rz: Math.PI / 2 },
    { shadow: false },
  );
  b.part(ctx.geometry.get("curtain.finial", () => new THREE.SphereGeometry(0.035, 10, 7)), pole, {
    x: width / 2 + 0.08,
    y: height + 0.04,
  });
}

/** Hanging shop sign. Swatch roles: 0 = board, 1 = chain and bracket. */
export function buildHangingSign(ctx: PropContext, placement: PropPlacement): void {
  const board = ctx.materials.get(swatchRole(placement, 0, "paint_midnight_02"));
  const metal = ctx.materials.get(swatchRole(placement, 1, "brass_aged_02"));
  const b = ctx.batcher;

  const chain = ctx.geometry.get("sign.chain", () => new THREE.CylinderGeometry(0.006, 0.006, 0.28, 5));
  for (const dx of [-0.24, 0.24]) {
    b.part(chain, metal, { x: dx, y: 0.14 }, { shadow: false });
  }
  b.part(ctx.geometry.get("sign.board", () => chamferedBox(0.66, 0.3, 0.035, 0.014)), board, { y: -0.15 });
  b.part(ctx.geometry.get("sign.trim", () => new THREE.TorusGeometry(0.11, 0.008, 6, 20)), metal, {
    y: -0.15,
    z: 0.024,
  });
}

/** Shallow display tray of small goods. Swatch roles: 0 = tray, 1 = lining. */
export function buildDisplayTray(ctx: PropContext, placement: PropPlacement): void {
  const tray = ctx.materials.get(swatchRole(placement, 0, "walnut_mid_02"));
  const lining = ctx.materials.get(swatchRole(placement, 1, "velvet_burgundy_01"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get("tray.base", () => chamferedSlab(0.44, 0.035, 0.3, 0.008)), tray, { y: 0.018 });
  const wall = ctx.geometry.get("tray.wallLong", () => chamferedBox(0.44, 0.05, 0.022, 0.006));
  const end = ctx.geometry.get("tray.wallShort", () => chamferedBox(0.022, 0.05, 0.3, 0.006));
  b.part(wall, tray, { y: 0.055, z: 0.14 }, { shadow: false });
  b.part(wall, tray, { y: 0.055, z: -0.14 }, { shadow: false });
  b.part(end, tray, { x: 0.21, y: 0.055 }, { shadow: false });
  b.part(end, tray, { x: -0.21, y: 0.055 }, { shadow: false });
  b.part(ctx.geometry.get("tray.lining", () => chamferedSlab(0.4, 0.014, 0.26, 0.004)), lining, { y: 0.043 }, { shadow: false });
}

/** Security Office desk with its monitor bank (§5.7). Swatch roles: 0 = desk, 1 = screens, 2 = legs. */
export function buildMonitorDesk(ctx: PropContext, placement: PropPlacement): void {
  const desk = ctx.materials.get(swatchRole(placement, 0, "slate_grey_02"));
  const screen = ctx.materials.get(swatchRole(placement, 1, "bakelite_black_01"));
  const metal = ctx.materials.get(swatchRole(placement, 2, "iron_dark_03"));
  const b = ctx.batcher;

  b.part(ctx.geometry.get("office.deskTop", () => chamferedSlab(1.5, 0.06, 0.7, 0.012)), desk, { y: 0.75 });
  const leg = ctx.geometry.get("office.deskLeg", () => chamferedBox(0.08, 0.72, 0.08, 0.012));
  for (const dx of [-0.66, 0.66]) {
    for (const dz of [-0.28, 0.28]) {
      b.part(leg, metal, { x: dx, y: 0.36, z: dz }, { shadow: false });
    }
  }
  const monitor = ctx.geometry.get("office.monitor", () => chamferedBox(0.42, 0.3, 0.06, 0.012));
  const stand = ctx.geometry.get("office.monitorStand", () => new THREE.CylinderGeometry(0.03, 0.05, 0.12, 8));
  for (const [dx, ry] of [
    [-0.46, 0.28],
    [0, 0],
    [0.46, -0.28],
  ] as const) {
    b.part(stand, metal, { x: dx, y: 0.84, z: -0.14 }, { shadow: false });
    b.part(monitor, screen, { x: dx, y: 1.05, z: -0.14, ry }, { shadow: false });
  }
}
