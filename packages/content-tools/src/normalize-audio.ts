import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BED_TARGET_LUFS, BED_TRUE_PEAK_DB, SFX_TARGET_LUFS, SFX_TRUE_PEAK_DB } from "./audio-levels.ts";

/**
 * Brings every bundled clip to the level `audio-levels.ts` asks for. Run offline
 * after `generate:audio`; nothing here ships.
 *
 * The generator's output is kept in `assets-source/audio-raw` and this reads
 * from there, never from the bundle it writes. That matters twice over. A
 * generated sound cannot be reproduced — the same prompt returns different
 * audio every time — so the raw take is the only copy there will ever be of it;
 * and normalising an already-normalised file would compound the gain, which
 * reading from a separate source makes impossible however often this is run.
 *
 * A clip with no raw copy yet is archived on the first run, so an existing
 * bundle becomes its own source once and is normalised from then on.
 *
 * Usage:
 *   pnpm --filter @foldseek/content-tools normalize:audio
 *   ... -- --check            measure and report, write nothing
 */

const run = promisify(execFile);

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLIENT_AUDIO = resolve(ROOT, "../../../apps/client/public/assets/audio");
const RAW_AUDIO = resolve(ROOT, "../../../assets-source/audio-raw");

/** Where each kind lives, under both roots. */
const KINDS = [
  { dir: "sfx", bitrate: "128k", truePeak: SFX_TRUE_PEAK_DB },
  { dir: "ambience", bitrate: "64k", truePeak: BED_TRUE_PEAK_DB },
] as const;

const checkOnly = process.argv.slice(2).includes("--check");

/** What loudnorm's first pass reports, and its second pass consumes. */
interface Measured {
  readonly input_i: string;
  readonly input_tp: string;
  readonly input_lra: string;
  readonly input_thresh: string;
  readonly target_offset: string;
}

function targetFor(dir: string, id: string): number | null {
  if (dir === "ambience") return BED_TARGET_LUFS;
  return SFX_TARGET_LUFS[id] ?? null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * ffmpeg writes its filter reports to stderr and exits 0, so a rejection here is
 * a real failure rather than the usual noise.
 */
async function ffmpegStderr(args: readonly string[]): Promise<string> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stderr;
}

/** Integrated loudness and true peak of a file as it stands. */
async function measure(path: string): Promise<{ lufs: number; truePeak: number }> {
  const stderr = await ffmpegStderr(["-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const summary = stderr.slice(stderr.lastIndexOf("Integrated loudness"));
  const lufs = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  const peak = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(summary);
  return {
    lufs: lufs?.[1] === undefined ? Number.NaN : Number(lufs[1]),
    truePeak: peak?.[1] === undefined ? Number.NaN : Number(peak[1]),
  };
}

async function measureLoudness(path: string): Promise<number> {
  return (await measure(path)).lufs;
}

/** loudnorm's analysis pass, which the correcting pass needs verbatim. */
async function analyse(path: string, target: number, truePeak: number): Promise<Measured> {
  const stderr = await ffmpegStderr([
    "-i",
    path,
    "-af",
    `loudnorm=I=${target}:TP=${truePeak}:LRA=11:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`loudnorm produced no measurement for ${path}`);
  }
  return JSON.parse(stderr.slice(start, end + 1)) as Measured;
}

/**
 * How far from target a clip may land before the constant-gain pass is judged
 * to have failed. Half a decibel is inaudible; two is the difference between a
 * gunshot that outranks a stinger and one that sits under it.
 */
const LINEAR_TOLERANCE_DB = 1.5;

/** Corrections converge in two or three; the cap is there so a clip that will
 * not converge is reported rather than re-encoded forever. */
const MAX_CORRECTIONS = 4;

/**
 * A correction smaller than this is not worth an encode, and a clip whose
 * remaining headroom is this small is at the ceiling for practical purposes.
 */
const CORRECTION_FLOOR_DB = 0.4;

async function encode(
  rawPath: string,
  outPath: string,
  target: number,
  truePeak: number,
  bitrate: string,
  measured: Measured,
  linear: boolean,
  trimDb = 0,
): Promise<void> {
  const loudnorm = [
    `loudnorm=I=${target}`,
    `TP=${truePeak}`,
    "LRA=11",
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    `linear=${linear ? "true" : "false"}`,
    "print_format=summary",
  ].join(":");
  // The correction rides after loudnorm in the same chain, so the file written
  // is always one encode away from the raw take however many passes it took to
  // work out what gain it needed.
  const filter = trimDb === 0 ? loudnorm : `${loudnorm},volume=${trimDb.toFixed(2)}dB`;
  await ffmpegStderr([
    "-y",
    "-i",
    rawPath,
    "-af",
    filter,
    // loudnorm resamples to 192 kHz internally; the bundle stays at 44.1.
    "-ar",
    "44100",
    "-c:a",
    "libmp3lame",
    "-b:a",
    bitrate,
    outPath,
  ]);
}

/**
 * Brings one clip to its target and reports where it landed.
 *
 * The first attempt applies a single constant gain, which leaves the clip's own
 * shape alone: a footstep keeps its attack and a riser keeps its swell. That is
 * the right answer for most of the set and it is tried first for all of it.
 *
 * It cannot always reach the target. A clip with a sharp transient over a quiet
 * body — the dust puff, the lamp switch, the shot — runs its peak into the
 * true-peak ceiling while its average is still far below where it should be, and
 * one gain cannot fix both ends at once. Those fall back to loudnorm's dynamic
 * mode, which rides the level to hit the target at the cost of some of the
 * transient. Which clips needed it is reported rather than hidden, because it is
 * a real trade and the list is the record of where it was made.
 */
async function normalizeOne(
  rawPath: string,
  outPath: string,
  target: number,
  truePeak: number,
  bitrate: string,
): Promise<{ achieved: number; peak: number; corrected: boolean; peakLimited: boolean }> {
  const measured = await analyse(rawPath, target, truePeak);
  await encode(rawPath, outPath, target, truePeak, bitrate, measured, true);
  let result = await measure(outPath);
  let trim = 0;

  // A clip can land short for two unrelated reasons and they need opposite
  // answers. Either its transient is already on the true-peak ceiling, in which
  // case it is as loud as it can be made without clipping and the shortfall is
  // real; or it still has headroom, and loudnorm simply mispredicted the gain.
  // It mispredicts on very quiet material because raising the floor brings more
  // of the clip above the loudness measurement's own gate, so the average rises
  // more slowly than the gain applied — which also means one correction
  // undershoots for the same reason the first estimate did, and the correction
  // has to be re-measured rather than trusted.
  for (let attempt = 0; attempt < MAX_CORRECTIONS; attempt += 1) {
    const shortfall = target - result.lufs;
    if (Math.abs(shortfall) <= LINEAR_TOLERANCE_DB) break;

    const headroom = truePeak - result.truePeak;
    const step = Math.min(shortfall, headroom);
    if (step <= CORRECTION_FLOOR_DB) {
      return { achieved: result.lufs, peak: result.truePeak, corrected: trim !== 0, peakLimited: true };
    }
    trim += step;
    await encode(rawPath, outPath, target, truePeak, bitrate, measured, true, trim);
    result = await measure(outPath);
  }

  return { achieved: result.lufs, peak: result.truePeak, corrected: trim !== 0, peakLimited: false };
}

let processed = 0;
let archived = 0;
const rows: string[] = [];
const missingTargets: string[] = [];
/**
 * Clips already on the true-peak ceiling and therefore as loud as they can be
 * made. Not a failure, but the list is worth reading: a clip far short here is
 * one whose generated take is mostly silence around a spike, and the fix for
 * that is a better take rather than more gain.
 */
const peakLimitedClips: string[] = [];
/** Clips that missed for any other reason, which would be a fault in this tool. */
const missedTarget: string[] = [];

for (const kind of KINDS) {
  const bundleDir = resolve(CLIENT_AUDIO, kind.dir);
  const rawDir = resolve(RAW_AUDIO, kind.dir);
  await mkdir(rawDir, { recursive: true });

  const files = (await readdir(bundleDir)).filter((name) => name.endsWith(".mp3")).sort();
  for (const file of files) {
    const id = file.slice(0, -".mp3".length);
    const target = targetFor(kind.dir, id);
    if (target === null) {
      missingTargets.push(id);
      continue;
    }

    const bundlePath = resolve(bundleDir, file);
    const rawPath = resolve(rawDir, file);
    // The first run adopts whatever is in the bundle as the raw take. After
    // that the archive is the source and the bundle is only ever an output.
    if (!(await exists(rawPath))) {
      await copyFile(bundlePath, rawPath);
      archived += 1;
    }

    const before = await measureLoudness(rawPath);
    if (checkOnly) {
      rows.push(`${kind.dir}/${id}\t${before.toFixed(1)}\t${target}\t(check only)`);
      continue;
    }
    const { achieved, peak, corrected, peakLimited } = await normalizeOne(
      rawPath,
      bundlePath,
      target,
      kind.truePeak,
      kind.bitrate,
    );
    processed += 1;
    const delta = achieved - target;
    const note = peakLimited ? "peak-limited" : corrected ? "corrected" : "clean";
    if (peakLimited) peakLimitedClips.push(`${id} (${delta.toFixed(1)} dB)`);
    else if (Math.abs(delta) > LINEAR_TOLERANCE_DB) {
      missedTarget.push(`${id} (${delta.toFixed(1)} dB)`);
    }
    rows.push(
      `${kind.dir}/${id}\t${before.toFixed(1)}\t${target}\t${achieved.toFixed(1)}\t${delta.toFixed(1)}\t${peak.toFixed(1)}\t${note}`,
    );
  }
}

if (missingTargets.length > 0) {
  console.error(
    `No level target for: ${missingTargets.join(", ")}. Add them to audio-levels.ts.`,
  );
}
console.log("clip\traw LUFS\ttarget\tresult\tdelta\tpeak\tnote");
for (const row of rows) console.log(row);
console.log(`\n${processed} normalised, ${archived} archived to assets-source/audio-raw.`);
if (peakLimitedClips.length > 0) {
  console.log(
    `\nat the peak ceiling, cannot go louder (${peakLimitedClips.length}): ${peakLimitedClips.join(", ")}`,
  );
}
if (missedTarget.length > 0) {
  console.log(`\nMISSED with headroom to spare (${missedTarget.length}): ${missedTarget.join(", ")}`);
}
process.exit(missingTargets.length > 0 || missedTarget.length > 0 ? 1 : 0);
