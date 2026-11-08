import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Stamp each build with its commit so the post-deploy check can wait for THIS build to be live.
const BUILD_ID = process.env.GITHUB_SHA ?? "local";
const buildStamp = {
  name: "pi-build-stamp",
  transformIndexHtml: () => [{ tag: "meta", attrs: { name: "pi-build", content: BUILD_ID }, injectTo: "head" as const }],
};

// Relative base + hash routing: the build works under any GitHub Pages sub-path
// (https://<user>.github.io/<repo>/) without knowing the repo name and without 404s on refresh.
export default defineConfig({
  base: "./",
  plugins: [react(), buildStamp],
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 400 },
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test-setup.ts"],
  },
});
