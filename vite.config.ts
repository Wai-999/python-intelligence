import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base + hash routing: the build works under any GitHub Pages sub-path
// (https://<user>.github.io/<repo>/) without knowing the repo name and without 404s on refresh.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 400 },
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test-setup.ts"],
  },
});
