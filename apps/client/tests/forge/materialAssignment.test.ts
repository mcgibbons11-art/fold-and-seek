import { describe, expect, it } from "vitest";

import {
  assignmentFor,
  assignmentSlots,
  BODY_SLOT_ID,
  isAssignableSlot,
  mirroredSlotId,
  resolvedSwatchFor,
  validateAssignment,
  withAssignment,
  withoutAssignment,
} from "../../src/forge/materialAssignment";
import type { MaterialAssignment } from "../../src/mimic/disguiseState";
import {
  MATERIAL_SWATCHES,
  MIMIC_LEGAL_SWATCHES,
  PORCELAIN_SWATCH_ID,
  swatchById,
} from "../../src/mimic/visual/materialSwatches";

const BODY: readonly MaterialAssignment[] = [
  { slotId: BODY_SLOT_ID, swatchId: PORCELAIN_SWATCH_ID },
];

describe("swatch catalogue", () => {
  it("publishes unique ids and a porcelain default", () => {
    const ids = new Set(MATERIAL_SWATCHES.map((swatch) => swatch.id));
    expect(ids.size).toBe(MATERIAL_SWATCHES.length);
    expect(swatchById(PORCELAIN_SWATCH_ID)?.legalForMimic).toBe(true);
  });

  it("keeps colours and material parameters inside their physical range", () => {
    for (const swatch of MATERIAL_SWATCHES) {
      expect(swatch.baseColor).toHaveLength(3);
      for (const channel of swatch.baseColor) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
      expect(swatch.roughness).toBeGreaterThanOrEqual(0);
      expect(swatch.roughness).toBeLessThanOrEqual(1);
      expect(swatch.metalness).toBeGreaterThanOrEqual(0);
      expect(swatch.metalness).toBeLessThanOrEqual(1);
    }
  });

  it("excludes swatches the map does not allow on a body", () => {
    expect(MIMIC_LEGAL_SWATCHES.every((swatch) => swatch.legalForMimic)).toBe(true);
    expect(MIMIC_LEGAL_SWATCHES.length).toBeLessThan(MATERIAL_SWATCHES.length);
  });
});

describe("slot assignment", () => {
  it("adds a slot that has none and replaces one that does", () => {
    const added = withAssignment(BODY, "hand_L", "wood_walnut");
    expect(added).toHaveLength(2);
    expect(assignmentFor(added, "hand_L")).toBe("wood_walnut");

    const replaced = withAssignment(added, "hand_L", "metal_brass");
    expect(replaced).toHaveLength(2);
    expect(assignmentFor(replaced, "hand_L")).toBe("metal_brass");
  });

  it("leaves the input list untouched", () => {
    const next = withAssignment(BODY, "head", "metal_brass");
    expect(BODY).toHaveLength(1);
    expect(next).not.toBe(BODY);
  });

  it("drops a slot back to the body swatch when cleared", () => {
    const painted = withAssignment(BODY, "foot_R", "metal_brass");
    expect(resolvedSwatchFor(painted, "foot_R", PORCELAIN_SWATCH_ID)).toBe("metal_brass");

    const cleared = withoutAssignment(painted, "foot_R");
    expect(assignmentFor(cleared, "foot_R")).toBeNull();
    expect(resolvedSwatchFor(cleared, "foot_R", PORCELAIN_SWATCH_ID)).toBe(PORCELAIN_SWATCH_ID);
  });

  it("falls back to the supplied default when nothing is assigned at all", () => {
    expect(resolvedSwatchFor([], "torso_upper", PORCELAIN_SWATCH_ID)).toBe(PORCELAIN_SWATCH_ID);
  });
});

describe("assignment legality", () => {
  it("accepts the body, any bone, and any panel socket", () => {
    expect(isAssignableSlot(BODY_SLOT_ID)).toBe(true);
    expect(isAssignableSlot("forearm_R")).toBe(true);
    expect(isAssignableSlot("panel_socket_08")).toBe(true);
    expect(isAssignableSlot("left_elbow")).toBe(false);
  });

  it("refuses an unknown slot and a swatch the map bars from a body", () => {
    expect(validateAssignment("head", "wood_walnut")).toBeNull();
    expect(validateAssignment("nose", "wood_walnut")).toBe("unknown-slot");
    expect(validateAssignment("head", "glass_window")).toBe("illegal-swatch");
    expect(validateAssignment("head", "not_a_swatch")).toBe("illegal-swatch");
  });
});

describe("mirrored assignment", () => {
  it("pairs left and right bones", () => {
    expect(mirroredSlotId("hand_L")).toBe("hand_R");
    expect(mirroredSlotId("thigh_R")).toBe("thigh_L");
  });

  it("pairs the sockets that hang off mirrored segments", () => {
    expect(mirroredSlotId("panel_socket_05")).toBe("panel_socket_06");
    expect(mirroredSlotId("panel_socket_08")).toBe("panel_socket_07");
  });

  it("has no mirror for a slot on the symmetry plane", () => {
    expect(mirroredSlotId("head")).toBeNull();
    expect(mirroredSlotId(BODY_SLOT_ID)).toBeNull();
    expect(mirroredSlotId("panel_socket_01")).toBeNull();
  });

  it("does not invent a partner for a name that merely ends in _L", () => {
    expect(mirroredSlotId("shelf_L")).toBeNull();
  });

  it("expands to a pair only when mirroring is on and a partner exists", () => {
    expect(assignmentSlots("hand_L", true)).toEqual(["hand_L", "hand_R"]);
    expect(assignmentSlots("hand_L", false)).toEqual(["hand_L"]);
    expect(assignmentSlots("head", true)).toEqual(["head"]);
  });
});
