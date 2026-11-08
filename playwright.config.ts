import { defineConfig, devices } from "@playwright/test";

// E2E against the PRODUCTION build served under a sub-path, like GitHub Pages (/<repo>/).
// Needs network: Pyodide loads from the pinned jsDelivr CDN.
const BASE_PATH = "/python-intelligence/";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:4173${BASE_PATH}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /smoke/ },
  ],
  webServer: {
    // Serve dist/ under the sub-path to prove the relative base works without knowing the repo name.
    command: `node e2e/serve.mjs ${BASE_PATH} 4173`,
    url: `http://127.0.0.1:4173${BASE_PATH}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
