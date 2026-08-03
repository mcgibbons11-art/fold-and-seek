/* global process */

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkOnly = process.argv.includes("--check");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const staged = resolve(tmpdir(), "foldseek-client-build");
const deployed = resolve(repoRoot, "portals");

async function filesUnder(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, child)));
    else if (entry.isFile()) files.push(child.replaceAll("\\", "/"));
  }
  return files;
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertCompleteBuild() {
  for (const required of ["index.html", "assets/characters/inspector-curator.glb"]) {
    const info = await stat(join(staged, required)).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new Error(`Portals staging build is incomplete: missing ${required}`);
    }
  }
}

async function staleEntries(currentFiles) {
  const current = new Set(
    currentFiles.filter((file) => /^assets\/index-.*\.(?:js|css)$/.test(file)),
  );
  const entries = await readdir(join(deployed, "assets"), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /^index-.*\.(?:js|css)$/.test(entry.name))
    .map((entry) => `assets/${entry.name}`)
    .filter((file) => !current.has(file));
}

await assertCompleteBuild();
const stagedFiles = await filesUnder(staged);

if (checkOnly) {
  const differences = [];
  for (const relative of stagedFiles) {
    const source = join(staged, relative);
    const target = join(deployed, relative);
    const targetInfo = await stat(target).catch(() => null);
    if (
      targetInfo === null ||
      !targetInfo.isFile() ||
      (await digest(source)) !== (await digest(target))
    ) {
      differences.push(relative);
    }
  }
  differences.push(...(await staleEntries(stagedFiles)));
  if (differences.length > 0) {
    throw new Error(
      `Tracked Portals bundle is stale (${differences.slice(0, 8).join(", ")}). Run pnpm build:portals.`,
    );
  }
  process.stdout.write(`Portals bundle matches ${stagedFiles.length} staged files.\n`);
} else {
  await mkdir(deployed, { recursive: true });
  await cp(staged, deployed, { recursive: true, force: true });
  for (const relative of await staleEntries(stagedFiles)) {
    await rm(join(deployed, relative), { force: true });
  }
  process.stdout.write(`Published ${stagedFiles.length} files to ${deployed}.\n`);
}
