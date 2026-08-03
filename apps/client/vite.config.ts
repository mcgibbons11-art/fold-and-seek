import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Dropbox intermittently locks `apps/client/dist/assets` while Vite is trying
 * to empty it. Verification output is disposable, so keep the default build in
 * the OS scratch area; hosted builds pass an explicit `--outDir portals`.
 */
const verificationOutDir = resolve(tmpdir(), "foldseek-client-build");
// Dropbox applies reparse/placeholder semantics inside node_modules. Vite's
// optimizer finalizes a dependency batch by renaming deps_temp_* to deps; in
// this workspace that rename can remain permanently half-finished and every
// browser then receives 504 Outdated Optimize Dep. The build already uses OS
// scratch space for the same reason, so keep the disposable dev cache there as
// well.
const dependencyCacheDir = resolve(tmpdir(), "foldseek-client-vite-cache");

// base: "./" is required for the Portals hosted-game bundle: Portals serves the
// processed build from a nested path and injects ./_portals/sdk.js, so every
// asset reference must be relative.
export default defineConfig({
  base: "./",
  cacheDir: dependencyCacheDir,
  plugins: [react()],
  resolve: {
    // Exactly one three.js build may exist at runtime. The renderer uses
    // "three/webgpu" (a superset of core); aliasing bare "three" onto it keeps
    // math classes (Vector3, Quaternion) identity-compatible across modules.
    alias: [{ find: /^three$/, replacement: "three/webgpu" }],
  },
  build: {
    outDir: verificationOutDir,
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4096,
    assetsInlineLimit: 0
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
