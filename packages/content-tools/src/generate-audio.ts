import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_SFX, AMBIENCE_BEDS, type SoundKind, type SoundSpec } from "./audio-manifest.ts";

/**
 * Generates every bundled sound from the manifest. Run offline; nothing here
 * ships. The key is read from the environment (see the package script, which
 * passes --env-file) and is never logged.
 *
 * Usage:
 *   pnpm --filter @foldseek/content-tools generate:audio
 *   ... -- --force            regenerate files that already exist
 *   ... -- --kind=bed         only the ambience beds
 *   ... -- --only=amb_clock_ticks,gun_fire
 */

const API_BASE = "https://api.elevenlabs.io/v1";
/** The only model with the seamless-loop flag the beds depend on. */
const MODEL_ID = "eleven_text_to_sound_v2";

/**
 * A one-shot keeps the bitrate the existing set was cut at. A bed is a quiet
 * continuous texture with no transients worth 128 kbps, and there are twelve of
 * them, so halving it halves the largest part of the audio bundle.
 */
const SFX_FORMAT = "mp3_44100_128";
const BED_FORMAT = "mp3_44100_64";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIRS: Readonly<Record<SoundKind, string>> = {
  sfx: resolve(ROOT, "../../../apps/client/public/assets/audio/sfx"),
  bed: resolve(ROOT, "../../../apps/client/public/assets/audio/ambience"),
};

const apiKey = process.env.ELEVENLABS_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  console.error("ELEVENLABS_API_KEY missing. Run via: pnpm --filter @foldseek/content-tools generate:audio");
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const kindFilter = args.find((arg) => arg.startsWith("--kind="))?.slice("--kind=".length);
const onlyFilter = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const onlyIds = onlyFilter === undefined ? null : new Set(onlyFilter.split(","));

/** Gentle pacing between calls, to stay under the API's rate limit. */
const PACING_MS = 400;

interface Job {
  readonly spec: SoundSpec;
  readonly kind: SoundKind;
}

const jobs: Job[] = [
  ...ALL_SFX.map((spec) => ({ spec, kind: "sfx" as const })),
  ...AMBIENCE_BEDS.map((spec) => ({ spec, kind: "bed" as const })),
].filter(
  (job) =>
    (kindFilter === undefined || job.kind === kindFilter) &&
    (onlyIds === null || onlyIds.has(job.spec.id)),
);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function generateSound(job: Job): Promise<"generated" | "skipped" | "failed"> {
  const outPath = resolve(OUT_DIRS[job.kind], `${job.spec.id}.mp3`);
  if (!force && (await exists(outPath))) return "skipped";

  const bed = job.kind === "bed";
  const format = bed ? BED_FORMAT : SFX_FORMAT;
  const response = await fetch(`${API_BASE}/sound-generation?output_format=${format}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey as string, "content-type": "application/json" },
    body: JSON.stringify({
      text: job.spec.prompt,
      duration_seconds: job.spec.durationSeconds,
      model_id: MODEL_ID,
      // A bed is held open and looped for as long as a phase lasts, so the
      // generator is asked for material that meets itself at the seam.
      loop: bed,
    }),
  });
  if (!response.ok) {
    console.error(`FAILED ${job.spec.id}: HTTP ${response.status} ${await response.text()}`);
    return "failed";
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(outPath, bytes);
  console.log(`generated ${job.kind}/${job.spec.id}.mp3 (${(bytes.length / 1024).toFixed(0)} KB)`);
  return "generated";
}

for (const dir of Object.values(OUT_DIRS)) await mkdir(dir, { recursive: true });

let failed = 0;
let generated = 0;
let skipped = 0;
for (const job of jobs) {
  const result = await generateSound(job);
  if (result === "failed") failed += 1;
  if (result === "generated") generated += 1;
  if (result === "skipped") skipped += 1;
  await new Promise((r) => setTimeout(r, PACING_MS));
}
console.log(`done. ${generated} generated, ${skipped} skipped, ${failed} failures.`);
process.exit(failed > 0 ? 1 : 0);
