import { expect, test } from "@playwright/test";

test("offline after a single visit", async ({ page, context }) => {
  // Disable Chromium's HTTP cache so only service-worker storage can satisfy reload.
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto("./");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Learn Python by running it." })).toBeVisible();
  await page.locator(".recommend").getByRole("button").click();
  await expect(page.locator("#step-title")).toBeVisible();
});

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

test("Python runs offline after a FIRST visit that lands directly on a lesson (no reload)", async ({ page, context }) => {
  test.setTimeout(240_000);
  // Only service-worker storage may satisfy the offline run: the HTTP cache is disabled.
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto("./#/lesson/py-files/4"); // first visit, deep link; the app warms Python on this route
  await expect(page.getByRole("heading", { name: "Run it: a tiny score file" })).toBeVisible();
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect(page.locator(".console pre").first()).toHaveText("20\nno such file\n", { timeout: 90_000 });
  await expect.poll(() => page.evaluate(async () => {
    const urls = (await (await caches.open("pi-pyodide-0.27.8")).keys()).map((r) => r.url);
    return ["pyodide.asm.wasm", "python_stdlib.zip"].every((f) => urls.some((u) => u.endsWith(f)));
  }), { timeout: 60_000 }).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Run it: a tiny score file" })).toBeVisible();
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect(page.locator(".console pre").first()).toHaveText("20\nno such file\n", { timeout: 90_000 });
});
