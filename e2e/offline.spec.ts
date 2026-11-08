import { expect, test } from "@playwright/test";

const runtime = "https://cdn.jsdelivr.net/pyodide/v0.27.8/full/";

async function waitForControl(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  });
}

test("cached app reloads offline under the GitHub Pages sub-path", async ({ page, context }) => {
  await page.goto("./");
  await waitForControl(page);
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const shell = await caches.open(keys.find((key) => key.includes(":shell:"))!);
    return (await shell.keys()).map((request) => request.url);
  });
  expect(cached.some((url) => /\/assets\/worker-[^/]+\.js$/.test(url))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Learn Python by running it." })).toBeVisible();
  await page.goto("./#/lesson/py-values-names/2");
  await expect(page.locator("textarea.editor-input")).toBeVisible();
});

test("pinned runtime responses survive offline reload; other versions are excluded", async ({ page, context }) => {
  // Synthetic CDN responses test caching without downloading or claiming to run
  // the real WASM runtime. Real Python execution is covered by learner.spec.ts.
  await context.route("https://cdn.jsdelivr.net/pyodide/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/octet-stream",
      headers: { "access-control-allow-origin": "*" }, body: "runtime-fixture" });
  });
  await page.goto("./");
  await waitForControl(page);
  const files = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
  for (const file of files) {
    expect(await page.evaluate(async (url) => (await fetch(url)).text(), runtime + file)).toBe("runtime-fixture");
  }
  await page.evaluate(async () => { await fetch("https://cdn.jsdelivr.net/pyodide/v0.26.0/full/pyodide.mjs"); });
  const keys = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names.find((name) => name.includes(":pyodide:"))!);
    return (await cache.keys()).map((request) => request.url);
  });
  expect(keys.sort()).toEqual(files.map((file) => runtime + file).sort());
  await context.unrouteAll();
  await context.setOffline(true);
  await page.reload();
  for (const file of files) {
    expect(await page.evaluate(async (url) => (await fetch(url)).text(), runtime + file)).toBe("runtime-fixture");
  }
  expect(await page.evaluate(async () => {
    try { await fetch("https://cdn.jsdelivr.net/pyodide/v0.26.0/full/pyodide.mjs"); return true; }
    catch { return false; }
  })).toBe(false);
});
