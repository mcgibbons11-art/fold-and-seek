import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import {
  applyDisguiseStateToPose,
  capturePoseToDisguiseState,
  cloneDisguiseState,
  createAllStarterArrangements,
  createDefaultDisguiseState,
  createStarterArrangement,
  deserializeDisguiseState,
  DisguiseStateError,
  DISGUISE_STATE_VERSION,
  serializeDisguiseState,
  STARTER_ARRANGEMENT_IDS,
  starterArrangementLabel,
  validateDisguiseState,
} from "../../src/mimic/disguiseState";
import { createDefaultPanelState } from "../../src/mimic/panels";
import {
  BONE_COUNT,
  BONE_NAMES,
  boneRotationViolation,
  RIG_VERSION,
  SEGMENT_BONES,
} from "../../src/mimic/rig";
import { createPoseState, isPoseFinite, solveIK } from "../../src/mimic/ikSolver";

describe("default disguise state", () => {
  it("validates with no errors", () => {
    const state = createDefaultDisguiseState();
    expect(validateDisguiseState(state)).toEqual([]);
    expect(state.version).toBe(DISGUISE_STATE_VERSION);
    expect(state.rigVersion).toBe(RIG_VERSION);
    expect(state.joints).toHaveLength(BONE_NAMES.length);
    expect(state.segments).toHaveLength(SEGMENT_BONES.length);
  });

  it("reports an out-of-limit joint", () => {
    const state = createDefaultDisguiseState();
    const shin = state.joints.find((joint) => joint.bone === "shin_L")!;
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    shin.rotation = [rotation.x, rotation.y, rotation.z, rotation.w];

    const errors = validateDisguiseState(state);
    expect(errors.some((error) => error.includes("shin_L") && error.includes("exceeds"))).toBe(
      true,
    );
  });

  it("reports a denormalized quaternion", () => {
    const state = createDefaultDisguiseState();
    state.joints[3]!.rotation = [0, 0, 0, 0];
    expect(
      validateDisguiseState(state).some((error) => error.includes("unit quaternion")),
    ).toBe(true);
  });

  it("reports an out-of-range segment parameter", () => {
    const state = createDefaultDisguiseState();
    state.segments[2]!.form.width = 4;
    expect(
      validateDisguiseState(state).some((error) => error.includes("out-of-range form")),
    ).toBe(true);
  });
});

describe("serialization", () => {
  it("round-trips through JSON unchanged", () => {
    const state = createStarterArrangement("shelf_bundle");
    state.mapId = "curiosity_shop";
    state.mapVersion = 3;
    state.revision = 17;
    state.panels = [createDefaultPanelState("panel_socket_01")];
    state.panels[0]!.snapTarget = {
      kind: "surface",
      targetId: "shelf_edge_12",
      offset: [0.01, -0.02, 0.03],
      normal: [0, 1, 0],
    };
    state.anchors = [
      {
        id: "anchor_a",
        bone: "hand_L",
        objectId: "shelf_12",
        uv: [0.25, 0.75],
        normalOffset: 0.004,
        localRotation: [0, 0, 0, 1],
        positionToleranceM: 0.01,
        angularToleranceDeg: 4,
      },
    ];
    state.materials = [
      { slotId: "body", swatchId: "oak_dark" },
      { slotId: "head", swatchId: "brass_worn" },
    ];

    const round = deserializeDisguiseState(JSON.parse(JSON.stringify(serializeDisguiseState(state))));
    expect(round).toEqual(state);
    expect(validateDisguiseState(round)).toEqual([]);
  });

  it("detaches the serialized copy from the source", () => {
    const state = createDefaultDisguiseState();
    const copy = serializeDisguiseState(state);
    copy.joints[1]!.rotation[0] = 0.5;
    copy.segments[0]!.form.length = 0.9;
    expect(state.joints[1]!.rotation[0]).toBe(0);
    expect(state.segments[0]!.form.length).not.toBe(0.9);
  });

  it("rejects a denormalized quaternion", () => {
    const payload = serializeDisguiseState(createDefaultDisguiseState());
    payload.joints[5]!.rotation = [0, 0, 0, 0.5];
    expect(() => deserializeDisguiseState(payload)).toThrow(DisguiseStateError);
  });

  it("rejects a segment list in the wrong order", () => {
    const payload = serializeDisguiseState(createDefaultDisguiseState());
    const first = payload.segments[0]!;
    payload.segments[0] = payload.segments[1]!;
    payload.segments[1] = first;
    expect(() => deserializeDisguiseState(payload)).toThrow(DisguiseStateError);
  });

  it("rejects a malformed payload", () => {
    expect(() => deserializeDisguiseState(null)).toThrow(DisguiseStateError);
    expect(() => deserializeDisguiseState({ version: 1 })).toThrow(DisguiseStateError);
    expect(() => deserializeDisguiseState([])).toThrow(DisguiseStateError);
  });

  it("clones without sharing nested arrays", () => {
    const state = createStarterArrangement("wide");
    const copy = cloneDisguiseState(state);
    copy.root.position[1] = 5;
    copy.materials.push({ slotId: "trim", swatchId: "brass" });
    expect(state.root.position[1]).toBe(0);
    expect(state.materials).toHaveLength(1);
  });
});

describe("starter arrangements", () => {
  it("provides all eight arrangements from §7.15", () => {
    expect(STARTER_ARRANGEMENT_IDS).toEqual([
      "upright",
      "compact",
      "wide",
      "tall",
      "tripod",
      "wall_mount",
      "shelf_bundle",
      "hanging",
    ]);
    expect(starterArrangementLabel("wall_mount")).toBe("Wall Mount");
  });

  it("validates every arrangement, joint limits included", () => {
    const arrangements = createAllStarterArrangements();
    for (const id of STARTER_ARRANGEMENT_IDS) {
      const state = arrangements[id];
      expect(validateDisguiseState(state), id).toEqual([]);

      const rotation = new Quaternion();
      for (let i = 0; i < state.joints.length; i++) {
        const joint = state.joints[i]!;
        rotation.set(joint.rotation[0], joint.rotation[1], joint.rotation[2], joint.rotation[3]);
        expect(boneRotationViolation(i, rotation), `${id}/${joint.bone}`).toBeLessThan(1e-6);
      }
    }
  });

  it("produces a finite, distinct pose for each arrangement", () => {
    const heights: number[] = [];
    const widths: number[] = [];

    for (const id of STARTER_ARRANGEMENT_IDS) {
      const pose = createPoseState();
      applyDisguiseStateToPose(createStarterArrangement(id), pose);
      expect(isPoseFinite(pose), id).toBe(true);

      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < BONE_COUNT; i++) {
        const position = pose.worldPositions[i]!;
        minY = Math.min(minY, position.y);
        maxY = Math.max(maxY, position.y);
        minX = Math.min(minX, position.x);
        maxX = Math.max(maxX, position.x);
      }
      heights.push(maxY - minY);
      widths.push(maxX - minX);
    }

    // Every arrangement keeps a real, inspectable body rather than collapsing.
    for (let i = 0; i < heights.length; i++) {
      expect(heights[i]!, STARTER_ARRANGEMENT_IDS[i]).toBeGreaterThan(0.2);
      expect(widths[i]!, STARTER_ARRANGEMENT_IDS[i]).toBeGreaterThan(0.05);
    }
    expect(new Set(heights.map((value) => value.toFixed(3))).size).toBeGreaterThanOrEqual(7);
  });

  it("stays legal after being solved from an arrangement", () => {
    const pose = createPoseState();
    applyDisguiseStateToPose(createStarterArrangement("tripod"), pose);

    const report = solveIK(pose, {
      hand_L: pose.worldPositions[BONE_NAMES.indexOf("hand_L")]!.clone().add(
        new Vector3(0.05, -0.05, 0.05),
      ),
    });

    expect(isPoseFinite(pose)).toBe(true);
    expect(report.maxError).toBeLessThan(0.02);
  });
});

describe("pose bridge", () => {
  it("round-trips a pose through a disguise state", () => {
    const source = createPoseState();
    applyDisguiseStateToPose(createStarterArrangement("compact"), source);

    const captured = capturePoseToDisguiseState(source, createDefaultDisguiseState());
    expect(captured.revision).toBe(1);
    expect(validateDisguiseState(captured)).toEqual([]);

    const restored = createPoseState();
    applyDisguiseStateToPose(captured, restored);

    for (let i = 0; i < BONE_COUNT; i++) {
      expect(restored.worldPositions[i]!.distanceTo(source.worldPositions[i]!)).toBeLessThan(1e-9);
    }
  });
});
