import type { ForgeToolMode } from "../../forge/ForgeController";
import {
  BOARD_RAIL_LABEL,
  MIRROR_RAIL_LABEL,
  TAUNT_LABEL,
  TOOL_RAIL_LABELS,
  tauntCooldownNote,
} from "../../gameplay/copy";

/**
 * The hunt's control surface as data, separate from the elements that draw it.
 *
 * Two things fall out of that separation. The rail and the hint strip can be
 * checked for double-bound keys and for a missing action without rendering
 * anything, which is what `huntControls.test.ts` does. And every entry here
 * quotes a key that some component actually listens for: the tool modes and
 * mirror come from `ForgeController.handleKey`, the missed-spot board and the
 * taunt from `RoundHud`, and the mouse verbs from `InspectorInput` and the
 * Forge's pointer handling. Nothing is advertised that does not fire.
 */

export type RailTone = "primary" | "normal" | "quiet";

export interface RailAction {
  readonly id: string;
  /** The key or button that triggers it, printed on the chip. */
  readonly key: string;
  readonly label: string;
  /** Icon beside the keycap, the way the original marks each rail entry. */
  readonly glyph: string;
  readonly tone: RailTone;
  readonly active: boolean;
  readonly enabled: boolean;
  /**
   * Whether clicking the chip does what the key does. False for the verbs that
   * live on the mouse itself: a button that fires the gun at whatever the
   * cursor left behind would be a different action from pulling the trigger.
   */
  readonly pressable: boolean;
  /** A word about why it cannot be used right now, or null when it can. */
  readonly note: string | null;
}

export interface ControlHint {
  readonly id: string;
  /** Keycaps for one control, pressed together when there is more than one. */
  readonly keys: readonly string[];
  readonly label: string;
}

const TOOL_RAIL_KEYS: Readonly<Record<ForgeToolMode, string>> = {
  pose: "1",
  shape: "2",
  panels: "3",
  material: "4",
  paint: "5",
};

const TOOL_RAIL_GLYPHS: Readonly<Record<ForgeToolMode, string>> = {
  pose: "⤧",
  shape: "◈",
  panels: "▤",
  material: "◐",
  paint: "✎",
};

/** The key `RoundHud` listens for to taunt. 1 belongs to the Forge's pose tool. */
export const TAUNT_KEY = "t";
/** The key `RoundHud` listens for to toggle the board, as in the original. */
export const MISSED_FINDS_KEY = "6";

export interface HiderRailInput {
  /** False when the authority has refused `taunt` as a command it does not know. */
  readonly tauntSupported: boolean;
  readonly tauntAllowed: boolean;
  readonly tauntCooldownSeconds: number;
  /** The tool the Forge is in, or null when this hider has no Forge open. */
  readonly toolMode: ForgeToolMode | null;
  readonly mirror: boolean;
  readonly boardOpen: boolean;
}

/**
 * A live hider's rail: bait first, then the tools they go on shaping the
 * disguise with, then the board. This is the same order the original runs its
 * rail in, with our tool set in place of its two.
 */
export function hiderRailActions(input: HiderRailInput): readonly RailAction[] {
  const actions: RailAction[] = [];

  if (input.tauntSupported) {
    actions.push({
      id: "taunt",
      key: TAUNT_KEY.toUpperCase(),
      label: TAUNT_LABEL,
      glyph: "✶",
      tone: "primary",
      active: false,
      enabled: input.tauntAllowed,
      pressable: true,
      note: input.tauntAllowed ? null : tauntCooldownNote(input.tauntCooldownSeconds),
    });
  }

  if (input.toolMode !== null) {
    for (const mode of Object.keys(TOOL_RAIL_KEYS) as ForgeToolMode[]) {
      actions.push({
        id: `tool:${mode}`,
        key: TOOL_RAIL_KEYS[mode],
        label: TOOL_RAIL_LABELS[mode],
        glyph: TOOL_RAIL_GLYPHS[mode],
        tone: "normal",
        active: input.toolMode === mode,
        enabled: true,
        pressable: true,
        note: null,
      });
    }
    actions.push({
      id: "mirror",
      key: "M",
      label: MIRROR_RAIL_LABEL,
      glyph: "⇋",
      tone: "quiet",
      active: input.mirror,
      enabled: true,
      pressable: true,
      note: null,
    });
  }

  actions.push(boardRailAction(input.boardOpen));
  return actions;
}

export interface InspectorRailInput {
  readonly boardOpen: boolean;
  readonly outOfWarrants: boolean;
}

/**
 * The Inspector's rail. Firing and aiming are on the mouse rather than a key,
 * but they are the two verbs the round is played with, so they belong on the
 * rail beside the board rather than buried in the locomotion strip.
 */
export function inspectorRailActions(input: InspectorRailInput): readonly RailAction[] {
  return [
    {
      id: "accuse",
      key: "LMB",
      label: "Fire a warrant",
      glyph: "◎",
      tone: "primary",
      active: false,
      enabled: !input.outOfWarrants,
      pressable: false,
      note: input.outOfWarrants ? "empty" : null,
    },
    {
      id: "focus",
      key: "RMB",
      label: "Aim",
      glyph: "◈",
      tone: "normal",
      active: false,
      enabled: true,
      pressable: false,
      note: null,
    },
    boardRailAction(input.boardOpen),
  ];
}

/**
 * The board toggle, which is on every role's rail: a caught hider and a live
 * one and the Inspector all read the same ranking, and that shared visibility is
 * what makes being seen worth playing for.
 */
export function boardRailAction(open: boolean): RailAction {
  return {
    id: "missedFinds",
    key: MISSED_FINDS_KEY,
    label: BOARD_RAIL_LABEL,
    glyph: "☰",
    tone: "quiet",
    active: open,
    enabled: true,
    pressable: true,
    note: null,
  };
}

/**
 * The three controls every player steers with, whatever their role, printed on
 * the title screen and on the role card so that nobody reaches the shop without
 * having been told how to move in it. Both role sets below repeat them, because
 * a strip that is up for the whole round has to be complete on its own.
 */
export const CORE_CONTROL_HINTS: readonly ControlHint[] = [
  { id: "walk", keys: ["W", "A", "S", "D"], label: "Move" },
  { id: "camera", keys: ["Hold LMB"], label: "Look around" },
  { id: "jump", keys: ["Space"], label: "Jump · hold forward at a solid to climb" },
];

/**
 * The controls a role card teaches, which is not the same list for both sides.
 *
 * An Inspector plays the round with the mouse: the room holds the pointer, so
 * looking around is the mouse itself rather than a held button, the left button
 * fires and the right aims. Reading those three off `InspectorInput`
 * (MOUSE_BUTTON_FIRE is the left, MOUSE_BUTTON_AIM the right, and `takeFirePressed`
 * is edge-triggered on the press) rather than assuming them is the point: the
 * card used to hand every role the Mimic's set, which told an Inspector to hold
 * the button that in fact spends a warrant round.
 */
export const INSPECTOR_ROLE_HINTS: readonly ControlHint[] = [
  { id: "walk", keys: ["W", "A", "S", "D"], label: "Walk" },
  { id: "camera", keys: ["Mouse"], label: "Look around" },
  { id: "fire", keys: ["LMB"], label: "Fire a warrant" },
  { id: "aim", keys: ["RMB"], label: "Aim" },
  { id: "jump", keys: ["Space"], label: "Hop · hold forward at a solid to climb" },
];

/** Which set a role card prints. Everyone but the Inspector takes the core set. */
export function roleCardHints(role: "mimic" | "inspector" | "spectator"): readonly ControlHint[] {
  return role === "inspector" ? INSPECTOR_ROLE_HINTS : CORE_CONTROL_HINTS;
}

/**
 * A hider's controls during the hunt (CLAUDE.md overrides 5 and 6). A Mimic
 * runs about the shop on WASD while it folds and keeps that run once the
 * disguise has manifested; space
 * hops; and the left button does two things depending on what is under it,
 * which is why it appears twice. Shift is absent because the run has one speed.
 *
 * The Inspector-eyeline preview is on E rather than the §7.5 space, because
 * space became the jump.
 */
export const HIDER_CONTROL_HINTS: readonly ControlHint[] = [
  { id: "walk", keys: ["W", "A", "S", "D"], label: "Run" },
  { id: "jump", keys: ["Space"], label: "Hop · hold forward at a solid to climb" },
  { id: "camera", keys: ["LMB"], label: "Look around" },
  { id: "drag", keys: ["LMB"], label: "On a handle: pose" },
  { id: "undo", keys: ["Ctrl", "Z"], label: "Undo" },
  { id: "silhouette", keys: ["V"], label: "Silhouette" },
  { id: "eyeline", keys: ["E"], label: "Their eyeline" },
];

/** The Inspector walks the room, so their strip is locomotion and the mouse. */
export const INSPECTOR_CONTROL_HINTS: readonly ControlHint[] = [
  { id: "walk", keys: ["W", "A", "S", "D"], label: "Walk" },
  { id: "jump", keys: ["Space"], label: "Hop" },
  { id: "brisk", keys: ["Shift"], label: "Hurry" },
  { id: "release", keys: ["Esc"], label: "Release the mouse" },
];
