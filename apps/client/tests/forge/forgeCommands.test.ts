import { describe, expect, it } from "vitest";

import {
  capturePoseSnapshot,
  createCompositeCommand,
  createMaterialCommand,
  createPanelCommand,
  createPoseCommand,
  createReplaceCommand,
  createSegmentFormCommand,
  ForgeCommandStack,
  poseSnapshotsEqual,
  restorePoseSnapshot,
  FORGE_UNDO_CAPACITY,
} from "../../src/forge/forgeCommands";
import {
  createDefaultDisguiseState,
  createStarterArrangement,
  type DisguiseState,
} from "../../src/mimic/disguiseState";
import { createDefaultPanelState } from "../../src/mimic/panels";
import { cloneSegmentForm, type SegmentFormState } from "../../src/mimic/segmentForm";

function formAt(state: DisguiseState, slot: number): SegmentFormState {
  const segment = state.segments[slot];
  if (segment === undefined) {
    throw new Error(`no segment at slot ${slot}`);
  }
  return segment.form;
}

function stretched(form: SegmentFormState, length: number): SegmentFormState {
  const copy = cloneSegmentForm(form);
  copy.length = length;
  return copy;
}

describe("segment form commands", () => {
  it("applies on push and restores the previous form on undo", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const before = cloneSegmentForm(formAt(state, 1));

    stack.push(createSegmentFormCommand(1, before, stretched(before, 0.9), 0), state);
    expect(formAt(state, 1).length).toBeCloseTo(0.9);
    expect(state.revision).toBe(1);

    stack.undo(state);
    expect(formAt(state, 1).length).toBeCloseTo(before.length);
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(true);

    stack.redo(state);
    expect(formAt(state, 1).length).toBeCloseTo(0.9);
  });

  it("keeps its own copies, so mutating the caller's form does not rewrite history", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const before = cloneSegmentForm(formAt(state, 2));
    const after = stretched(before, 0.8);

    stack.push(createSegmentFormCommand(2, before, after, 0), state);
    after.length = 0.1;

    stack.undo(state);
    stack.redo(state);
    expect(formAt(state, 2).length).toBeCloseTo(0.8);
  });

  it("names the command an undo would revert", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const before = cloneSegmentForm(formAt(state, 0));
    stack.push(createSegmentFormCommand(0, before, stretched(before, 0.7), 0), state);
    expect(stack.nextUndoLabel).toBe("shape pelvis");
  });

  it("rejects a command aimed at a segment the rig does not have", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const before = cloneSegmentForm(formAt(state, 0));
    expect(() => {
      stack.push(createSegmentFormCommand(99, before, stretched(before, 0.5), 0), state);
    }).toThrow(/segment slot 99/);
  });
});

describe("undo history", () => {
  it("discards the redo tail once a new command is pushed", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const before = cloneSegmentForm(formAt(state, 1));

    stack.push(createSegmentFormCommand(1, before, stretched(before, 0.9), 0), state);
    stack.undo(state);
    expect(stack.canRedo).toBe(true);

    stack.push(createSegmentFormCommand(1, before, stretched(before, 0.2), 1), state);
    expect(stack.canRedo).toBe(false);
    expect(stack.undoDepth).toBe(1);
    expect(formAt(state, 1).length).toBeCloseTo(0.2);
  });

  it("holds at least the 64 commands bible §7.14 requires and drops the oldest beyond that", () => {
    expect(FORGE_UNDO_CAPACITY).toBeGreaterThanOrEqual(64);

    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack(4);
    const base = cloneSegmentForm(formAt(state, 1));
    for (let i = 0; i < 6; i++) {
      const before = cloneSegmentForm(formAt(state, 1));
      stack.push(createSegmentFormCommand(1, before, stretched(base, 0.1 * (i + 1)), i), state);
    }
    expect(stack.undoDepth).toBe(4);

    for (let i = 0; i < 4; i++) {
      stack.undo(state);
    }
    expect(stack.canUndo).toBe(false);
    // The two dropped commands are gone, so the oldest surviving "before" wins.
    expect(formAt(state, 1).length).toBeCloseTo(0.2);
  });

  it("returns null rather than throwing at either end of the history", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    expect(stack.undo(state)).toBeNull();
    expect(stack.redo(state)).toBeNull();
    expect(state.revision).toBe(0);
  });

  it("clears to an empty history", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const before = cloneSegmentForm(formAt(state, 1));
    stack.push(createSegmentFormCommand(1, before, stretched(before, 0.9), 0), state);
    stack.clear();
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
  });
});

describe("grouped commands", () => {
  it("takes one undo to reverse a mirrored pair of edits", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const leftBefore = cloneSegmentForm(formAt(state, 8));
    const rightBefore = cloneSegmentForm(formAt(state, 12));

    stack.push(
      createCompositeCommand(
        "shape hand_L",
        [
          createSegmentFormCommand(8, leftBefore, stretched(leftBefore, 0.9), 0),
          createSegmentFormCommand(12, rightBefore, stretched(rightBefore, 0.9), 0),
        ],
        0,
      ),
      state,
    );
    expect(formAt(state, 8).length).toBeCloseTo(0.9);
    expect(formAt(state, 12).length).toBeCloseTo(0.9);
    expect(stack.undoDepth).toBe(1);

    stack.undo(state);
    expect(formAt(state, 8).length).toBeCloseTo(leftBefore.length);
    expect(formAt(state, 12).length).toBeCloseTo(rightBefore.length);
    expect(stack.canUndo).toBe(false);
  });

  it("reverts its parts in reverse order", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const before = cloneSegmentForm(formAt(state, 1));

    // Both parts write the same slot, so only reverse-order revert restores it.
    stack.push(
      createCompositeCommand(
        "double write",
        [
          createSegmentFormCommand(1, before, stretched(before, 0.4), 0),
          createSegmentFormCommand(1, stretched(before, 0.4), stretched(before, 0.8), 0),
        ],
        0,
      ),
      state,
    );
    expect(formAt(state, 1).length).toBeCloseTo(0.8);

    stack.undo(state);
    expect(formAt(state, 1).length).toBeCloseTo(before.length);
  });
});

describe("panel commands", () => {
  it("adds and removes a panel on the socket it names", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const panel = createDefaultPanelState("panel_socket_03");
    panel.deployed = 0.6;

    stack.push(createPanelCommand("panel_socket_03", null, panel, 0), state);
    expect(state.panels).toHaveLength(1);
    expect(state.panels[0]?.deployed).toBeCloseTo(0.6);

    stack.undo(state);
    expect(state.panels).toHaveLength(0);

    stack.redo(state);
    expect(state.panels).toHaveLength(1);

    const deployed = state.panels[0];
    if (deployed === undefined) {
      throw new Error("panel missing after redo");
    }
    stack.push(createPanelCommand("panel_socket_03", deployed, null, 1), state);
    expect(state.panels).toHaveLength(0);
  });

  it("edits a panel in place without disturbing the others", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const first = createDefaultPanelState("panel_socket_01");
    const second = createDefaultPanelState("panel_socket_02");
    stack.push(createPanelCommand("panel_socket_01", null, first, 0), state);
    stack.push(createPanelCommand("panel_socket_02", null, second, 1), state);

    const widened = { ...second, width: 0.95 };
    stack.push(createPanelCommand("panel_socket_02", second, widened, 2), state);

    expect(state.panels).toHaveLength(2);
    expect(state.panels.find((entry) => entry.socketId === "panel_socket_02")?.width).toBeCloseTo(0.95);
    expect(state.panels.find((entry) => entry.socketId === "panel_socket_01")?.width).toBeCloseTo(
      first.width,
    );
  });
});

describe("material commands", () => {
  it("writes every named slot and restores each slot's own previous value", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    state.materials.push({ slotId: "hand_R", swatchId: "metal_brass" });

    stack.push(
      createMaterialCommand(["hand_L", "hand_R"], [null, "metal_brass"], "wood_walnut", 0),
      state,
    );
    expect(state.materials.find((entry) => entry.slotId === "hand_L")?.swatchId).toBe("wood_walnut");
    expect(state.materials.find((entry) => entry.slotId === "hand_R")?.swatchId).toBe("wood_walnut");

    stack.undo(state);
    expect(state.materials.find((entry) => entry.slotId === "hand_L")).toBeUndefined();
    expect(state.materials.find((entry) => entry.slotId === "hand_R")?.swatchId).toBe("metal_brass");
    expect(state.materials.find((entry) => entry.slotId === "body")?.swatchId).toBe("mimic_porcelain");
  });
});

describe("pose snapshots", () => {
  it("round-trips the root transform and every joint", () => {
    const state = createStarterArrangement("tripod");
    const snapshot = capturePoseSnapshot(state);
    const restored = createDefaultDisguiseState();

    restorePoseSnapshot(restored, snapshot);
    expect(poseSnapshotsEqual(capturePoseSnapshot(restored), snapshot)).toBe(true);
    expect(restored.root.rotation).toEqual(state.root.rotation);
  });

  it("detects a difference in a single joint", () => {
    const state = createDefaultDisguiseState();
    const before = capturePoseSnapshot(state);
    const joint = state.joints[7];
    if (joint === undefined) {
      throw new Error("rig has no joint 7");
    }
    joint.rotation = [0, 0.3826834, 0, 0.9238795];
    expect(poseSnapshotsEqual(before, capturePoseSnapshot(state))).toBe(false);
  });

  it("undoes a pose edit as one command", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    const before = capturePoseSnapshot(state);
    const posed = capturePoseSnapshot(createStarterArrangement("wide"));

    stack.push(createPoseCommand(before, posed, 0), state);
    expect(poseSnapshotsEqual(capturePoseSnapshot(state), posed)).toBe(true);

    stack.undo(state);
    expect(poseSnapshotsEqual(capturePoseSnapshot(state), before)).toBe(true);
  });
});

describe("whole-state replacement", () => {
  it("swaps in a starter arrangement and puts the previous disguise back on undo", () => {
    const state = createDefaultDisguiseState();
    const stack = new ForgeCommandStack();
    state.materials.push({ slotId: "head", swatchId: "wood_walnut" });
    const before = capturePoseSnapshot(state);

    const next = createStarterArrangement("tall");
    stack.push(createReplaceCommand(state, next, 0, "arrangement tall"), state);
    expect(formAt(state, 3).length).toBeCloseTo(formAt(next, 3).length);
    expect(state.materials.find((entry) => entry.slotId === "head")).toBeUndefined();

    stack.undo(state);
    expect(poseSnapshotsEqual(capturePoseSnapshot(state), before)).toBe(true);
    expect(state.materials.find((entry) => entry.slotId === "head")?.swatchId).toBe("wood_walnut");
  });
});
