import { describe, expect, it } from "vitest";

import { MAX_PANELS, PANEL_SOCKET_NAMES } from "../../src/mimic/rig";
import {
  clampPanelState,
  clonePanelState,
  createDefaultPanelState,
  createResolvedPanel,
  PANEL_MAX_EXTENSION_M,
  PANEL_MAX_HINGE_DEG,
  PANEL_SIZE_MAX_M,
  PANEL_SIZE_MIN_M,
  resolvePanel,
  validatePanels,
  type PanelState,
} from "../../src/mimic/panels";

function fullPanelSet(): PanelState[] {
  return PANEL_SOCKET_NAMES.map((socket) => createDefaultPanelState(socket));
}

describe("panel legality", () => {
  it("accepts one panel per socket up to the eight-socket limit", () => {
    const panels = fullPanelSet();
    expect(panels).toHaveLength(MAX_PANELS);
    expect(validatePanels(panels)).toEqual([]);
  });

  it("rejects more panels than the rig has sockets", () => {
    const panels = [...fullPanelSet(), createDefaultPanelState("panel_socket_01")];
    const errors = validatePanels(panels);
    expect(errors.some((error) => error.includes("exceeds"))).toBe(true);
  });

  it("rejects two panels on the same socket", () => {
    const panels = [
      createDefaultPanelState("panel_socket_03"),
      createDefaultPanelState("panel_socket_03"),
    ];
    expect(validatePanels(panels)).toEqual([
      'panels[1] reuses socket "panel_socket_03"',
    ]);
  });

  it("rejects an unknown socket", () => {
    const panel = createDefaultPanelState("panel_socket_01");
    const broken = panel as unknown as { socketId: string };
    broken.socketId = "panel_socket_09";
    expect(validatePanels([panel]).some((error) => error.includes("unknown socket"))).toBe(true);
  });

  it("rejects out-of-range parameters", () => {
    const panel = createDefaultPanelState("panel_socket_02");
    panel.deployed = 1.5;
    panel.hingeAngle = 400;
    panel.extension = Number.NaN;
    panel.width = -0.2;
    const errors = validatePanels([panel]);
    expect(errors).toContain("panels[0].deployed out of range");
    expect(errors).toContain("panels[0].hingeAngle out of range");
    expect(errors).toContain("panels[0].extension out of range");
    expect(errors).toContain("panels[0].width out of range");
  });

  it("rejects a panel that snaps to itself or to a degenerate normal", () => {
    const panel = createDefaultPanelState("panel_socket_05");
    panel.snapTarget = {
      kind: "panel",
      targetId: "panel_socket_05",
      offset: [0, 0, 0],
      normal: [0, 0, 0],
    };
    const errors = validatePanels([panel]);
    expect(errors).toContain("panels[0] snaps to itself");
    expect(errors).toContain("panels[0].snapTarget.normal is degenerate");
  });

  it("rejects a snap to a panel socket that does not exist", () => {
    const panel = createDefaultPanelState("panel_socket_06");
    panel.snapTarget = {
      kind: "panel",
      targetId: "shelf_edge_12",
      offset: [0, 0.1, 0],
      normal: [0, 1, 0],
    };
    expect(
      validatePanels([panel]).some((error) => error.includes("unknown panel socket")),
    ).toBe(true);
  });

  it("accepts a snap to a world surface", () => {
    const panel = createDefaultPanelState("panel_socket_07");
    panel.snapTarget = {
      kind: "surface",
      targetId: "shelf_edge_12",
      offset: [0, 0.1, 0],
      normal: [0, 1, 0],
    };
    expect(validatePanels([panel])).toEqual([]);
  });
});

describe("panel clamping and resolution", () => {
  it("makes an illegal panel legal", () => {
    const panel = createDefaultPanelState("panel_socket_04");
    panel.deployed = 4;
    panel.hingeAngle = -900;
    panel.extension = Number.NaN;
    panel.width = 12;
    panel.height = -3;
    panel.snapTarget = {
      kind: "panel",
      targetId: "panel_socket_04",
      offset: [0, 0, 0],
      normal: [1, 0, 0],
    };

    clampPanelState(panel);

    expect(panel.deployed).toBe(1);
    expect(panel.hingeAngle).toBe(-PANEL_MAX_HINGE_DEG);
    expect(panel.extension).toBe(0);
    expect(panel.width).toBe(1);
    expect(panel.height).toBe(0);
    expect(panel.snapTarget).toBeUndefined();
    expect(validatePanels([panel])).toEqual([]);
  });

  it("maps normalized size and extension onto metres", () => {
    const resolved = createResolvedPanel();
    const panel = createDefaultPanelState("panel_socket_08");
    panel.width = 0;
    panel.height = 1;
    panel.extension = 1;
    panel.hingeAngle = 90;

    resolvePanel(panel, resolved);

    expect(resolved.widthM).toBeCloseTo(PANEL_SIZE_MIN_M, 10);
    expect(resolved.heightM).toBeCloseTo(PANEL_SIZE_MAX_M, 10);
    expect(resolved.extensionM).toBeCloseTo(PANEL_MAX_EXTENSION_M, 10);
    expect(resolved.hingeRad).toBeCloseTo(Math.PI / 2, 10);
  });

  it("clones a panel without sharing its snap target", () => {
    const panel = createDefaultPanelState("panel_socket_01");
    panel.snapTarget = {
      kind: "surface",
      targetId: "table_top",
      offset: [0.1, 0.2, 0.3],
      normal: [0, 1, 0],
    };
    const copy = clonePanelState(panel);
    copy.snapTarget!.offset[0] = 9;

    expect(panel.snapTarget!.offset[0]).toBe(0.1);
    expect(copy).not.toBe(panel);
  });
});
