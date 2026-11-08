import { expect, test } from "@playwright/test";

test("Python runs offline after one online visit under the deployment sub-path", async ({ page, context }) => {
  test.setTimeout(240_000);
  await page.goto("./#/lesson/py-files/4");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // Start the module worker from a page controlled by the service worker.
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.getByRole("heading", { name: "Run it: a tiny score file" })).toBeVisible();
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect(page.locator(".console pre").first()).toHaveText("20\nno such file\n", { timeout: 90_000 });

  // Wait for background runtime writes to finish before simulating disconnection.
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open("pi-pyodide-0.27.8");
    const urls = (await cache.keys()).map((request) => request.url);
    return ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]
      .every((file) => urls.includes(`https://cdn.jsdelivr.net/pyodide/v0.27.8/full/${file}`));
  })).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Run it: a tiny score file" })).toBeVisible();
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect(page.locator(".console pre").first()).toHaveText("20\nno such file\n", { timeout: 90_000 });
});
