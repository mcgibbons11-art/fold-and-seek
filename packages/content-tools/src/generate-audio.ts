import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SFX, type SoundSpec } from "./audio-manifest.ts";

const API_BASE = "https://api.elevenlabs.io/v1";
const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/client/public/assets/audio/sfx",
);

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("ELEVENLABS_API_KEY missing. Run via: pnpm --filter @foldseek/content-tools generate:audio");
  process.exit(1);
}

const force = process.argv.includes("--force");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function generateSound(spec: SoundSpec): Promise<"generated" | "skipped" | "failed"> {
  const outPath = resolve(OUT_DIR, `${spec.id}.mp3`);
  if (!force && (await exists(outPath))) return "skipped";

  const response = await fetch(`${API_BASE}/sound-generation`, {
    method: "POST",
    headers: { "xi-api-key": apiKey as string, "content-type": "application/json" },
    body: JSON.stringify({ text: spec.prompt, duration_seconds: spec.durationSeconds }),
  });
  if (!response.ok) {
    console.error(`FAILED ${spec.id}: HTTP ${response.status} ${await response.text()}`);
    return "failed";
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(outPath, bytes);
  console.log(`generated ${spec.id}.mp3 (${(bytes.length / 1024).toFixed(0)} KB)`);
  return "generated";
}

await mkdir(OUT_DIR, { recursive: true });
let failed = 0;
for (const spec of CORE_SFX) {
  const result = await generateSound(spec);
  if (result === "failed") failed += 1;
  // Gentle pacing to stay under API rate limits.
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`done. ${failed} failures.`);
process.exit(failed > 0 ? 1 : 0);
