import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const REPO_ROOT = resolve(__dirname, "../../../..");
const SUPPLIED_MANIFEST = resolve(REPO_ROOT, "assets-source/audio-supplied/manifest.json");
const DERIVED_ROOT = resolve(REPO_ROOT, "assets-source/audio-derived");

interface AudioProbe {
  readonly duration: number;
  readonly codec: string;
  readonly sampleRate: number;
}

interface SuppliedManifest {
  readonly sources: readonly {
    readonly id: string;
    readonly file: string;
    readonly durationSeconds: number;
    readonly sha256: string;
    readonly sourceUrl: string | null;
    readonly license: {
      readonly status: "requires_verification" | "verified";
      readonly name: string | null;
      readonly url: string | null;
    };
  }[];
  readonly derivatives: readonly {
    readonly id: string;
    readonly sourceId: string;
    readonly kind: "sfx" | "ambience";
    readonly durationSeconds: number;
    readonly targetLufs: number;
    readonly shipEligible: boolean;
  }[];
}

const supplied = JSON.parse(readFileSync(SUPPLIED_MANIFEST, "utf8")) as SuppliedManifest;

function probe(path: string): AudioProbe {
  const output = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,sample_rate",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(output) as {
    readonly streams?: readonly { readonly codec_name?: string; readonly sample_rate?: string }[];
    readonly format?: { readonly duration?: string };
  };
  return {
    duration: Number(parsed.format?.duration),
    codec: parsed.streams?.[0]?.codec_name ?? "",
    sampleRate: Number(parsed.streams?.[0]?.sample_rate),
  };
}

function loudness(path: string): { readonly lufs: number; readonly peak: number } {
  const measured = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const output = measured.stderr;
  const summary = output.slice(output.lastIndexOf("Integrated loudness"));
  return {
    lufs: Number(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary)?.[1]),
    peak: Number(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(summary)?.[1]),
  };
}

function audioFiles(root: string): string[] {
  return ["sfx", "ambience"].flatMap((kind) =>
    readdirSync(resolve(root, kind)).map((file) => resolve(root, kind, file)),
  );
}

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
   * anyway. The traversal state machine now wires the former wall-stick holdouts,
   * so there are deliberately no exceptions to this check.
   *
   * A `SoundId` reaches the player only by appearing as a literal somewhere in
   * `src`, so that is what is searched for.
   */
  it("plays every one-shot it ships", () => {
    const unplayed = SOUND_IDS.filter((id) => !sourceText().includes(`"${id}"`));
    expect(unplayed).toEqual([]);
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

  it("ships only MP3 files at the normalized sample rate and keeps one-shots short", () => {
    for (const path of audioFiles(AUDIO_ROOT)) {
      expect(path.endsWith(".mp3")).toBe(true);
      const metadata = probe(path);
      expect(metadata.codec).toBe("mp3");
      expect(metadata.sampleRate).toBe(44_100);
      expect(metadata.duration).toBeGreaterThan(0.05);
      if (path.includes(`${resolve(AUDIO_ROOT, "sfx")}`)) expect(metadata.duration).toBeLessThanOrEqual(4);
    }
  }, 30_000);

  it("has no duplicate encoded files in the shipped audio bundle", () => {
    const hashes = audioFiles(AUDIO_ROOT).map((path) =>
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    );
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("keeps unverified supplied recordings and their derivatives out of the bundle", () => {
    const sourceIds = new Set(supplied.sources.map((source) => source.id));
    for (const source of supplied.sources) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      if (source.license.status === "requires_verification") {
        expect(source.license.name).toBeNull();
        expect(source.license.url).toBeNull();
      }
    }
    for (const derivative of supplied.derivatives) {
      expect(sourceIds.has(derivative.sourceId)).toBe(true);
      const source = supplied.sources.find((candidate) => candidate.id === derivative.sourceId);
      if (source?.license.status !== "verified") expect(derivative.shipEligible).toBe(false);
      expect(derivative.durationSeconds).toBeLessThan(source?.durationSeconds ?? 0);
      expect(bundled(derivative.kind)).not.toContain(derivative.id);
    }
  });

  it("derives exactly the declared bounded clips in MP3 format", () => {
    const declared = supplied.derivatives.map((recipe) => `${recipe.kind}/${recipe.id}.mp3`).sort();
    const actual = ["sfx", "ambience"]
      .flatMap((kind) => readdirSync(resolve(DERIVED_ROOT, kind)).map((file) => `${kind}/${file}`))
      .sort();
    expect(actual).toEqual(declared);

    for (const recipe of supplied.derivatives) {
      const path = resolve(DERIVED_ROOT, recipe.kind, `${recipe.id}.mp3`);
      const metadata = probe(path);
      expect(metadata.codec).toBe("mp3");
      expect(metadata.sampleRate).toBe(44_100);
      expect(metadata.duration).toBeCloseTo(recipe.durationSeconds, 1);
      if (recipe.kind === "sfx") expect(metadata.duration).toBeLessThanOrEqual(4);
    }
  }, 30_000);

  it("normalizes derived clips to their declared level without clipping", () => {
    for (const recipe of supplied.derivatives) {
      const path = resolve(DERIVED_ROOT, recipe.kind, `${recipe.id}.mp3`);
      const measured = loudness(path);
      expect(measured.peak).toBeLessThanOrEqual(-0.8);
      // EBU R128 gates clips shorter than 400 ms as silence. Their peak ceiling
      // still protects them; integrated loudness is meaningful for longer takes.
      if (recipe.durationSeconds >= 0.4) {
        expect(measured.lufs).toBeGreaterThanOrEqual(recipe.targetLufs - 0.8);
        expect(measured.lufs).toBeLessThanOrEqual(recipe.targetLufs + 0.8);
      }
    }
  }, 30_000);
});
