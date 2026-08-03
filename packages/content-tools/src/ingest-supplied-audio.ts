import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

interface LicenseRecord {
  readonly status: "requires_verification" | "verified";
  readonly name: string | null;
  readonly url: string | null;
}

interface SuppliedSource {
  readonly id: string;
  readonly file: string;
  readonly durationSeconds: number;
  readonly sha256: string;
  readonly creditedCreator: string;
  readonly title: string;
  readonly sourceUrl: string | null;
  readonly license: LicenseRecord;
}

interface DerivativeRecipe {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: "sfx" | "ambience";
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly targetLufs: number;
  readonly shipEligible: boolean;
}

interface SuppliedAudioManifest {
  readonly sources: readonly SuppliedSource[];
  readonly derivatives: readonly DerivativeRecipe[];
}

const run = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const MANIFEST_PATH = resolve(REPO_ROOT, "assets-source/audio-supplied/manifest.json");
const DEFAULT_SOURCE_DIR = resolve(REPO_ROOT, "../sound effects");
const OUTPUT_ROOT = resolve(REPO_ROOT, "assets-source/audio-derived");
const checkOnly = process.argv.slice(2).includes("--check");
const sourceArgument = process.argv.find((argument) => argument.startsWith("--source="));
const sourceDir = sourceArgument === undefined ? DEFAULT_SOURCE_DIR : resolve(sourceArgument.slice(9));

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function encode(sourcePath: string, outputPath: string, recipe: DerivativeRecipe): Promise<void> {
  const fadeOutStart = Math.max(0, recipe.durationSeconds - 0.04);
  const filter = [
    `atrim=start=${recipe.startSeconds}:duration=${recipe.durationSeconds}`,
    "asetpts=PTS-STARTPTS",
    "afade=t=in:st=0:d=0.01",
    `afade=t=out:st=${fadeOutStart}:d=0.04`,
    `loudnorm=I=${recipe.targetLufs}:TP=-1:LRA=7`,
  ].join(",");
  await mkdir(dirname(outputPath), { recursive: true });
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      sourcePath,
      "-af",
      filter,
      "-ar",
      "44100",
      "-c:a",
      "libmp3lame",
      "-b:a",
      recipe.kind === "ambience" ? "64k" : "128k",
      outputPath,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as SuppliedAudioManifest;
const sources = new Map(manifest.sources.map((source) => [source.id, source]));
const failures: string[] = [];

for (const source of manifest.sources) {
  const path = resolve(sourceDir, source.file);
  let actualHash: string;
  try {
    actualHash = await sha256(path);
  } catch {
    failures.push(`${source.file}: missing from ${sourceDir}`);
    continue;
  }
  if (actualHash !== source.sha256) failures.push(`${source.file}: SHA-256 does not match manifest`);
  if (source.license.status === "requires_verification" && (source.license.name !== null || source.license.url !== null)) {
    failures.push(`${source.file}: unverified license must not claim a name or URL`);
  }
}

for (const recipe of manifest.derivatives) {
  const source = sources.get(recipe.sourceId);
  if (source === undefined) {
    failures.push(`${recipe.id}: unknown source ${recipe.sourceId}`);
    continue;
  }
  if (recipe.kind === "sfx" && recipe.durationSeconds > 4) {
    failures.push(`${recipe.id}: one-shot recipe is longer than four seconds`);
  }
  if (recipe.startSeconds < 0 || recipe.durationSeconds <= 0 || recipe.startSeconds + recipe.durationSeconds > source.durationSeconds) {
    failures.push(`${recipe.id}: extraction falls outside ${source.file}`);
  }
  if (source.license.status !== "verified" && recipe.shipEligible) {
    failures.push(`${recipe.id}: cannot ship before ${source.file} has a verified license`);
  }
  if (!checkOnly) {
    await encode(
      resolve(sourceDir, source.file),
      resolve(OUTPUT_ROOT, recipe.kind, `${recipe.id}.mp3`),
      recipe,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(
  checkOnly
    ? `Verified ${manifest.sources.length} supplied sources and ${manifest.derivatives.length} recipes.`
    : `Derived ${manifest.derivatives.length} normalized clips into assets-source/audio-derived.`,
);
