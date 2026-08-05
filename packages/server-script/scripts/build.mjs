/* global process */

import { build } from "esbuild";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundles the authority into the one file the Portals sandbox will run.
 *
 * Portals takes `server.js` from the directory it SERVES, which for this
 * project is the built bundle in `portals/` rather than the repository root.
 * That was settled by experiment on 2026-08-06, not inferred from the docs -
 * see docs/PORTALS_CONSTRAINTS.md.
 *
 * The sandbox rules are checked here rather than trusted: one script, no
 * imports, no browser globals, inside the documented size cap. A bundle that
 * breaks any of them fails the build instead of failing silently in a session.
 */

const checkOnly = process.argv.includes("--check");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(packageRoot, "../..");
const outfile = resolve(repoRoot, "portals/server.js");

/** The documented cap is 512 KB; stop well short so a change has room. */
const SIZE_LIMIT_BYTES = 512 * 1024;
const SIZE_WARN_BYTES = 440 * 1024;

/** None of these exist in the sandbox, so none may appear in the output. */
const FORBIDDEN = [
  "window.",
  "document.",
  "localStorage",
  "navigator.",
  "XMLHttpRequest",
  "WebSocket",
  "process.env",
];

const previous = checkOnly ? await readFile(outfile, "utf8").catch(() => null) : null;

await build({
  entryPoints: [resolve(packageRoot, "src/main.ts")],
  outfile,
  bundle: true,
  format: "iife",
  platform: "neutral",
  target: "es2020",
  minify: true,
  legalComments: "none",
  banner: {
    js:
      "/* FOLD & SEEK authoritative server script - generated from " +
      "packages/server-script by pnpm build:server. Do not edit here. */",
  },
});

const source = await readFile(outfile, "utf8");
const bytes = (await stat(outfile)).size;

const problems = [];
if (bytes > SIZE_LIMIT_BYTES) {
  problems.push(`bundle is ${String(bytes)} bytes, over the ${String(SIZE_LIMIT_BYTES)} cap`);
}
for (const token of FORBIDDEN) {
  if (source.includes(token)) problems.push(`bundle references \`${token}\`, absent in the sandbox`);
}
// An IIFE must not have survived with module syntax in it.
if (/(^|\n)\s*(import|export)\s/.test(source)) {
  problems.push("bundle still contains module syntax");
}
if (problems.length > 0) {
  process.stderr.write(`server script rejected:\n- ${problems.join("\n- ")}\n`);
  process.exit(1);
}

if (checkOnly && previous !== source) {
  const why = previous === null ? "is missing" : "is stale";
  process.stderr.write(`portals/server.js ${why}. Run pnpm build:portals.\n`);
  process.exit(1);
}

const headroom = SIZE_LIMIT_BYTES - bytes;
process.stdout.write(
  `server.js ${String(Math.round(bytes / 1024))} KB (${String(Math.round(headroom / 1024))} KB under the cap)\n`,
);
if (bytes > SIZE_WARN_BYTES) {
  process.stdout.write("warning: the server script is approaching the sandbox size cap\n");
}
