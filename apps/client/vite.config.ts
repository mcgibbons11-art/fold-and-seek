import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" is required for the Portals hosted-game bundle: Portals serves the
// processed build from a nested path and injects ./_portals/sdk.js, so every
// asset reference must be relative.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4096,
    assetsInlineLimit: 0
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
