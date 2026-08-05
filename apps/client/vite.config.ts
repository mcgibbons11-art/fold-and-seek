import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Declares a Portals dev token before anything else on the page.
 *
 * The SDK reads `window.__PORTALS_DEV__` once, when it loads, and captures its
 * mode there and then. Setting the global afterwards - from a module, or from
 * the console - does nothing at all, and `net.join()` goes on failing with
 * "no host page". So the declaration has to be the first script in the
 * document, which is why this is an HTML transform rather than application
 * code.
 *
 * `apply: "serve"` is the safety property that matters: a token is the account
 * holder's credential for eight hours, and this plugin cannot run during a
 * build, so no published bundle can carry one however the env is set.
 *
 * Pair it with a copy of the SDK at `public/_portals/sdk.js`, which is
 * gitignored; see docs/PORTALS_CONSTRAINTS.md for how to fetch one. With both
 * in place `pnpm dev` is a real Portals session on the fenced `dev:` channel
 * namespace, and several tabs are several players.
 */
function portalsDevToken(token: string): Plugin {
  return {
    name: "foldseek-portals-dev-token",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        {
          tag: "script",
          injectTo: "head-prepend" as const,
          children: `window.__PORTALS_DEV__=${JSON.stringify({ token })};`,
        },
      ],
    },
  };
}

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
export default defineConfig(({ mode }) => {
  const devToken = loadEnv(mode, process.cwd(), "VITE_").VITE_PORTALS_DEV_TOKEN;

  return {
  base: "./",
  cacheDir: dependencyCacheDir,
  plugins: [react(), ...(devToken ? [portalsDevToken(devToken)] : [])],
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
  };
});
