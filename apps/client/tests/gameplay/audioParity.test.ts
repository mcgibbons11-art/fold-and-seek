import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { SoundId } from "../../src/forge/AudioPlayer";
import { BED_IDS } from "../../src/gameplay/AmbienceController";
import { REACTION_SOUNDS, PHASE_SOUNDS } from "../../src/gameplay/huntCues";
import { footstepMaterial } from "../../src/gameplay/footsteps";

/**
 * The bundle and the code have to agree about what exists. Three vocabularies
 * meet here — the generator's manifest, the `SoundId` union the client plays by,
 * and the files actually sitting in `public/assets/audio` — and a mismatch in
 * any direction is silent at run time: a missing file logs one warning and
 * plays nothing, and an unreferenced file is weight the player downloads and
 * never hears.
 *
 * `SoundId` is a type and cannot be enumerated at run time, so the union is
 * mirrored here as a list and the mirror is what the files are checked against.
 * The compiler checks the mirror against the union (see `ExhaustiveCheck`
 * below), which is what keeps the two from drifting.
 */

const AUDIO_ROOT = resolve(__dirname, "../../public/assets/audio");

function bundled(dir: string): string[] {
  return readdirSync(resolve(AUDIO_ROOT, dir))
    .filter((name) => name.endsWith(".mp3"))
    .map((name) => name.slice(0, -".mp3".length))
    .sort();
}

/** Every member of the `SoundId` union, mirrored for run-time comparison. */
const SOUND_IDS = [
  "ui_click",
  "ui_hover",
  "ui_confirm",
  "material_sample",
  "anchor_snap",
  "panel_snap",
  "servo_move",
  "lock_seal",
  "door_open",
  "unfold_reveal",
  "caught_sting",
  "wrong_horn",
  "lamp_switch",
  "chair_squeak",
  "vase_dust_puff",
  "clock_chime",
  "kettle_whistle",
  "footstep_wood",
  "footstep_wood_2",
  "footstep_wood_3",
  "footstep_rug",
  "footstep_rug_2",
  "footstep_rug_3",
  "footstep_metal",
  "footstep_metal_2",
  "footstep_metal_3",
  "footstep_glass",
  "footstep_glass_2",
  "footstep_glass_3",
  "jump_takeoff",
  "land_soft",
  "land_hard",
  "climb_grab",
  "climb_grab_2",
  "wallstick_attach",
  "wallstick_release",
  "creep_slide",
  "gun_aim",
  "gun_fire",
  "gun_dry_click",
  "hunt_riser",
  "reveal_swell",
  "results_resolve",
  "rematch_tick",
  "ui_deny",
  "ui_back",
  "countdown_tick",
  "countdown_tick_final",
  "score_tick",
  "paint_stroke",
  "eyedropper_pick",
  "taunt_call",
  "close_pass_riser",
  "escape_relief",
  "role_reveal",
  "forge_start",
  "win_sting",
  "lose_sting",
] as const;

/**
 * The mirror above and the `SoundId` union have to be the same set. This fails
 * to compile the moment either gains a member the other does not have, which is
 * what makes the run-time checks below trustworthy: they are comparing files
 * against the real union, not against a list that quietly fell behind it.
 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const SOUND_IDS_MATCH_UNION: Equals<SoundId, (typeof SOUND_IDS)[number]> = true;

/**
 * Sounds that are bundled and named but which nothing plays, each with the
 * reason it is allowed to stay. This list is meant to shrink.
 *
 * The wall-stick pair belongs to a movement verb that CLAUDE.md lists alongside
 * jump and climb but which no controller implements: nothing in `src` sets,
 * clears or reports a stuck state, so there is no moment to hang them on. They
 * are kept rather than deleted because the feature is intended and a generated
 * take cannot be reproduced once thrown away.
 */
const UNWIRED_SOUNDS: ReadonlySet<string> = new Set(["wallstick_attach", "wallstick_release"]);

const SRC_ROOT = resolve(__dirname, "../../src");

/**
 * The file that declares the `SoundId` union. Every id appears in it by
 * definition, so searching it would match all of them and prove nothing: it is
 * the declaration, not a use. Leaving it in is what made the first version of
 * the check below pass on the very sounds it was written to catch.
 */
const DECLARATION_FILE = resolve(SRC_ROOT, "forge/AudioPlayer.ts");

let sourceCache: string | null = null;

/** Every line of client source that could play something, concatenated once. */
function sourceText(): string {
  if (sourceCache !== null) return sourceCache;
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = resolve(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path === DECLARATION_FILE) continue;
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
        parts.push(readFileSync(path, "utf8"));
      }
    }
  };
  walk(SRC_ROOT);
  sourceCache = parts.join("\n");
  return sourceCache;
}

describe("audio bundle parity", () => {
  it("mirrors the SoundId union exactly", () => {
    expect(SOUND_IDS_MATCH_UNION).toBe(true);
  });

  it("ships exactly the one-shots the client can name", () => {
    expect(bundled("sfx")).toEqual([...SOUND_IDS].sort());
  });

  it("ships exactly the ambience beds the controller can name", () => {
    expect(bundled("ambience")).toEqual([...BED_IDS].sort());
  });

  it("names a bundled clip for every innocent reaction", () => {
    for (const clip of Object.values(REACTION_SOUNDS)) {
      expect(SOUND_IDS).toContain(clip);
    }
  });

  it("names bundled clips for every phase that opens on a sound", () => {
    const table = Object.values(PHASE_SOUNDS).filter((clips) => clips !== undefined);
    expect(table.length).toBeGreaterThan(0);
    for (const clips of table) {
      expect(clips.length).toBeGreaterThan(0);
      for (const clip of clips) expect(SOUND_IDS).toContain(clip);
    }
  });

  /**
   * Parity above only proves a file exists and can be named. It does not prove
   * anything ever plays it, and the difference is invisible at run time: a sound
   * nobody triggers is silence the player cannot report and weight they download
   * anyway. Both wall-stick clips sat in the bundle unplayed through eight
   * gauntlet rounds because every check up to here passed on them.
   *
   * A `SoundId` reaches the player only by appearing as a literal somewhere in
   * `src`, so that is what is searched for.
   */
  it("plays every one-shot it ships", () => {
    const unplayed = SOUND_IDS.filter(
      (id) => !UNWIRED_SOUNDS.has(id) && !sourceText().includes(`"${id}"`),
    );
    expect(unplayed).toEqual([]);
  });

  it("has a live feature behind every sound it excuses as unwired", () => {
    // An excuse that outlives its reason is how the list stops meaning anything,
    // so a sound both excused and wired is a failure in the other direction.
    const excusedButWired = [...UNWIRED_SOUNDS].filter((id) => sourceText().includes(`"${id}"`));
    expect(excusedButWired).toEqual([]);
  });

  it("gives every footstep material three variations that are all bundled", () => {
    for (const surface of ["floor_00", "floor_02", "shelving_board_1", "counter_top"]) {
      const material = footstepMaterial(surface);
      const variations = SOUND_IDS.filter(
        (id) => id === `footstep_${material}` || id.startsWith(`footstep_${material}_`),
      );
      expect(variations).toHaveLength(3);
    }
  });
});
