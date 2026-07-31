import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Baked in so the UI has a real version before Tauri's getVersion() resolves (and at all when the
// frontend runs in a plain browser, where that call doesn't exist). Read rather than imported so
// no resolveJsonModule flag is needed. Ported from the community edition — local feature, so it
// belongs in both.
const pkgVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// Tauri expects a fixed dev port and no clearing of its own logs.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    sourcemap: false,
  },
});
