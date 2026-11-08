import { defineConfig, devices } from "@playwright/test";

// E2E against the PRODUCTION build served under a sub-path, like GitHub Pages (/<repo>/).
// Needs network: Pyodide loads from the pinned jsDelivr CDN.
const BASE_PATH = "/python-intelligence/";
// PI_E2E_PORT lets two runs (e.g. the orchestrator's acceptance tests and a local run) coexist.
const PORT = Number(process.env.PI_E2E_PORT ?? 4173);
// PI_BASE_URL runs the suite against an already-deployed site (CI's post-deploy check) instead of local dist/.
const LIVE = process.env.PI_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: LIVE ?? `http://127.0.0.1:${PORT}${BASE_PATH}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /smoke/ },
  ],
  webServer: LIVE ? undefined : {
    // Serve dist/ under the sub-path to prove the relative base works without knowing the repo name.
    command: `node e2e/serve.mjs ${BASE_PATH} ${PORT}`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
