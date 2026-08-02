import { describe, expect, it } from "vitest";

import { FORGE_TOOL_MODES } from "../../src/forge/ForgeController";
import {
  HIDER_CONTROL_HINTS,
  INSPECTOR_CONTROL_HINTS,
  MISSED_FINDS_KEY,
  TAUNT_KEY,
  hiderRailActions,
  inspectorRailActions,
  type RailAction,
} from "../../src/ui/rounds/huntControls";

/**
 * What the hunt tells the player they can press, checked against what the game
 * actually listens for. Two failures are worth catching here rather than in a
 * screenshot: an action with no control at all, and one key printed on two
 * chips, which is how the Forge's tool keys and a taunt on 1 would have
 * collided.
 */

const HIDER_INPUT = {
  tauntSupported: true,
  tauntAllowed: true,
  tauntCooldownSeconds: 0,
  toolMode: "pose" as const,
  mirror: false,
  boardOpen: false,
};

function keysOf(actions: readonly RailAction[]): string[] {
  return actions.map((action) => action.key);
}

function idsOf(actions: readonly RailAction[]): string[] {
  return actions.map((action) => action.id);
}

describe("hider rail", () => {
  const actions = hiderRailActions(HIDER_INPUT);

  it("binds no key twice", () => {
    const keys = keysOf(actions);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lists every action exactly once", () => {
    const ids = idsOf(actions);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("taunt");
    expect(ids).toContain("missedFinds");
    expect(ids).toContain("mirror");
    for (const mode of FORGE_TOOL_MODES) {
      expect(ids.filter((id) => id === `tool:${mode}`)).toHaveLength(1);
    }
  });

  it("keeps the taunt off 1, which the Forge's pose tool owns", () => {
    const taunt = actions.find((action) => action.id === "taunt");
    const pose = actions.find((action) => action.id === "tool:pose");
    expect(pose?.key).toBe("1");
    expect(taunt?.key).toBe(TAUNT_KEY.toUpperCase());
    expect(taunt?.key).not.toBe(pose?.key);
  });

  it("puts the board on the key the original uses", () => {
    const board = actions.find((action) => action.id === "missedFinds");
    expect(board?.key).toBe(MISSED_FINDS_KEY);
    expect(MISSED_FINDS_KEY).toBe("6");
  });

  it("marks the selected tool and the mirror as active", () => {
    const shaped = hiderRailActions({ ...HIDER_INPUT, toolMode: "shape", mirror: true });
    expect(shaped.filter((action) => action.active).map((action) => action.id).sort()).toEqual([
      "mirror",
      "tool:shape",
    ]);
  });

  it("shows the taunt disabled with its cooldown rather than hiding it", () => {
    const cooling = hiderRailActions({
      ...HIDER_INPUT,
      tauntAllowed: false,
      tauntCooldownSeconds: 3,
    });
    const taunt = cooling.find((action) => action.id === "taunt");
    expect(taunt?.enabled).toBe(false);
    expect(taunt?.note).toBe("3s");
  });

  it("drops the taunt entirely when the authority does not know the command", () => {
    const unsupported = hiderRailActions({ ...HIDER_INPUT, tauntSupported: false });
    expect(idsOf(unsupported)).not.toContain("taunt");
    expect(idsOf(unsupported)).toContain("missedFinds");
  });

  it("drops the tool chips when there is no Forge to drive", () => {
    const noForge = hiderRailActions({ ...HIDER_INPUT, toolMode: null });
    expect(idsOf(noForge)).toEqual(["taunt", "missedFinds"]);
  });
});

describe("inspector rail", () => {
  const actions = inspectorRailActions({ boardOpen: false, outOfWarrants: false });

  it("binds no key twice and lists no action twice", () => {
    expect(new Set(keysOf(actions)).size).toBe(actions.length);
    expect(new Set(idsOf(actions)).size).toBe(actions.length);
  });

  it("carries the two verbs the round is played with, plus the board", () => {
    expect(idsOf(actions)).toEqual(["accuse", "focus", "missedFinds"]);
  });

  it("leaves the mouse verbs unclickable", () => {
    // Clicking a chip cannot fire the gun: the shot goes where the reticle is,
    // and the cursor is not there.
    expect(actions.find((action) => action.id === "accuse")?.pressable).toBe(false);
    expect(actions.find((action) => action.id === "focus")?.pressable).toBe(false);
    expect(actions.find((action) => action.id === "missedFinds")?.pressable).toBe(true);
  });

  it("greys the trigger when the magazine is empty", () => {
    const empty = inspectorRailActions({ boardOpen: false, outOfWarrants: true });
    const accuse = empty.find((action) => action.id === "accuse");
    expect(accuse?.enabled).toBe(false);
    expect(accuse?.note).toBe("empty");
  });

  it("never offers a taunt", () => {
    expect(idsOf(actions)).not.toContain("taunt");
  });
});

describe("control hints", () => {
  it("give each role a distinct set with no repeated entry", () => {
    for (const hints of [HIDER_CONTROL_HINTS, INSPECTOR_CONTROL_HINTS]) {
      const ids = hints.map((hint) => hint.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const hint of hints) expect(hint.keys.length).toBeGreaterThan(0);
    }
  });

  it("offer a hider no walk keys, because there is no walk", () => {
    // CLAUDE.md override 4: a hider creeps by being dragged, and there is no
    // jump. Printing WASD here would promise controls that do nothing.
    const printed = HIDER_CONTROL_HINTS.flatMap((hint) => hint.keys);
    for (const key of ["W", "A", "S", "D"]) expect(printed).not.toContain(key);
    expect(HIDER_CONTROL_HINTS.map((hint) => hint.id)).toContain("drag");
  });

  it("give the Inspector locomotion, which is what they steer with", () => {
    const walk = INSPECTOR_CONTROL_HINTS.find((hint) => hint.id === "walk");
    expect(walk?.keys).toEqual(["W", "A", "S", "D"]);
  });
});
