import { expect, test, type Page } from "@playwright/test";
import conditionals from "../content/lessons/py-conditionals.json" with { type: "json" };

const titles = (conditionals as { steps: { title: string }[] }).steps.map((s) => s.title);

/** Time to show lesson step i: stops only when that step's own heading is on screen. */
async function stepTime(page: Page, i: number) {
  const start = Date.now();
  await page.goto(`./#/lesson/py-conditionals/${i}`);
  await expect(page.locator("#step-title")).toHaveText(titles[i]!);
  return Date.now() - start;
}

/**
 * Python on a fresh page: the cold figure runs from opening the exercise (Pyodide's start-up, which the app begins in
 * the background as soon as a lesson with code is open, included) to the first output; the first-click figure is the
 * time from pressing Run to that output, after that background warm-up has had however long the learner took to click.
 */
async function pythonTimes(page: Page, timeout: number) {
  const opened = Date.now();
  await page.goto("./#/lesson/py-functions/4");
  const editor = page.locator("textarea.editor-input");
  const run = async (code: string, expected: string) => {
    await editor.fill(code);
    const start = Date.now();
    await page.getByRole("button", { name: "▶ Run" }).click();
    await expect(page.locator(".console pre").first()).toHaveText(expected, { timeout });
    return Date.now() - start;
  };
  const firstClick = await run("print(1 + 1)\n", "2\n");
  const coldFromOpen = Date.now() - opened;
  const warm = [await run("print(2 + 2)\n", "4\n"), await run("print(sum(range(1000)))\n", "499500\n")];
  return { coldFromOpen, firstClick, warm };
}

// Performance measurements (master prompt §10 and Phase 7 "performance budgets"). The budgets are deliberately loose
// regression guards for a local production build, not targets; the measured numbers are printed as a PERF line so the
// release report can quote them with the conditions they were taken under.

test("load, navigation, Python runs and memory stay within budget", async ({ page }) => {
  test.setTimeout(300_000);
  const t0 = Date.now();
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const nav = await page.evaluate(() => {
    const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return { domContentLoaded: Math.round(e.domContentLoadedEventEnd), load: Math.round(e.loadEventEnd), transferKB: Math.round(e.transferSize / 1024) };
  });
  const firstPaint = await page.evaluate(() => Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1));

  // Moving between lesson steps (no network: lessons are bundled).
  const stepTimes: number[] = [];
  for (const i of [0, 1, 2, 3]) stepTimes.push(await stepTime(page, i));
  // Python on a fresh page, so nothing has warmed it yet.
  const fresh = await page.context().newPage();
  const py = await pythonTimes(fresh, 180_000);
  const warmRuns = py.warm;

  const heapMB = await fresh.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m ? Math.round(m.usedJSHeapSize / 1048576) : -1;
  });

  const perf = { ...nav, firstContentfulPaint: firstPaint, stepNavigationMs: stepTimes, pythonColdFromOpenMs: py.coldFromOpen, pythonFirstClickMs: py.firstClick, pythonWarmRunMs: warmRuns,
    mainThreadHeapMB: heapMB, totalMs: Date.now() - t0 };
  console.log(`PERF ${JSON.stringify(perf)}`);

  expect(nav.domContentLoaded, "DOMContentLoaded").toBeLessThan(3000);
  expect(Math.max(...stepTimes), "slowest step navigation").toBeLessThan(1500);
  expect(Math.max(...warmRuns), "slowest warm Python run").toBeLessThan(3000);
  if (heapMB >= 0) expect(heapMB, "main-thread JS heap").toBeLessThan(150);
});

test("on a CPU slowed four times, the same journey stays usable", async ({ page }) => {
  test.setTimeout(300_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const domContentLoaded = await page.evaluate(() => Math.round((performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).domContentLoadedEventEnd));
  const stepTimes: number[] = [];
  for (const i of [0, 1, 2, 3]) stepTimes.push(await stepTime(page, i));
  const fresh = await page.context().newPage();
  await (await page.context().newCDPSession(fresh)).send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const py = await pythonTimes(fresh, 240_000);
  const warmRun = Math.max(...py.warm);
  console.log(`PERF-SLOW ${JSON.stringify({ cpuThrottle: 4, domContentLoaded, stepNavigationMs: stepTimes, pythonColdFromOpenMs: py.coldFromOpen, pythonFirstClickMs: py.firstClick, pythonWarmRunMs: py.warm })}`);
  expect(domContentLoaded).toBeLessThan(6000);
  expect(Math.max(...stepTimes)).toBeLessThan(3000);
  expect(warmRun).toBeLessThan(6000);
});
