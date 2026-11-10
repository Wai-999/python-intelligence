import { expect, test } from "@playwright/test";
import lesson from "../content/lessons/np-arrays.json" with { type: "json" };

test("lesson packages load before examples and exercise checks; pandas is supported", async ({ page }) => {
  test.setTimeout(240_000);
  let workerUrl = "";
  page.on("request", (request) => {
    if (/\/assets\/worker-[^/]+\.js$/.test(new URL(request.url()).pathname)) workerUrl = request.url();
  });
  await page.goto("./#/lesson/np-arrays/4");
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect(page.locator(".console pre").first()).toHaveText("(2, 3)\n20.166666666666668\n[21 24]\n[21 24 22]\n[[35 41 33]\n [47 43 37]]\n", { timeout: 120_000 });
  await expect(page.locator(".console-error")).toHaveCount(0);
  // A second run reuses the loaded package in the same interpreter.
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect(page.locator(".console pre").first()).toContainText("(2, 3)");
  await page.goto("./#/lesson/np-arrays/5");
  await page.locator("textarea.editor-input").fill(
    lesson.steps[5]!.solution!,
  );
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible();

  // There is no pandas lesson yet: exercise the production worker protocol directly.
  expect(workerUrl).not.toBe("");
  const output = await page.evaluate((url) => new Promise<string>((resolve, reject) => {
    const worker = new Worker(url, { type: "module" });
    let stdout = "";
    let runId = 1;
    let repeatLoaded = false;
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("Package run timed out")); }, 120_000);
    worker.onmessage = ({ data }) => {
      if (data.type === "ready") worker.postMessage({ id: 1, type: "run", packages: ["unsupported-package"],
        code: "raise AssertionError('must not execute without packages')", tests: [] });
      if (data.type === "result" && runId === 1 && data.result?.error?.type === "PackageError") {
        runId = 2;
        worker.postMessage({ id: runId, type: "run", packages: ["pandas", "pandas"],
          code: "import pandas as pd\nprint(pd.Series([2, 4, 6]).sum())", tests: [] });
        return;
      }
      if (data.type === "packages-loading" && runId === 3) repeatLoaded = true;
      if (data.type === "result" && runId === 2 && data.result?.ok) {
        runId = 3;
        worker.postMessage({ id: runId, type: "run", packages: ["pandas"],
          code: "import pandas as pd\nprint(pd.Series([1, 2]).sum())", tests: [] });
        return;
      }
      if (data.type === "stdout") stdout += data.text;
      if (data.type === "result" || data.type === "load-error") {
        clearTimeout(timer);
        worker.terminate();
        if (data.result?.ok && runId === 3 && !repeatLoaded) resolve(stdout);
        else reject(new Error(JSON.stringify(data)));
      }
    };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
  }), workerUrl);
  expect(output).toBe("123");
});

test("the pandas lesson runs in the browser and its challenge checks pass", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("./#/lesson/pd-dataframes/4"); // "Run it: a small results table"
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect(page.locator(".console pre").first())
    .toHaveText("(4, 3)\n6.666666666666667\n['Ana', 'Bo']\n1\n{'blue': 9.0, 'red': 11.0}\n", { timeout: 180_000 });
  await page.goto("./#/lesson/pd-dataframes/6"); // "Challenge: team averages"
  await page.locator("textarea.editor-input").fill(
    'import pandas as pd\n\ndef team_averages(df):\n    return df.groupby("team")["score"].mean().round(1).to_dict()\n');
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
});

test("runs sent while packages load wait their turn and keep their own output", async ({ page }) => {
  test.setTimeout(240_000);
  let workerUrl = "";
  page.on("request", (request) => {
    if (/\/assets\/worker-[^/]+\.js$/.test(new URL(request.url()).pathname)) workerUrl = request.url();
  });
  await page.goto("./#/lesson/np-arrays/4");
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect.poll(() => workerUrl, { timeout: 120_000 }).not.toBe("");
  const seen = await page.evaluate((url) => new Promise<{ order: number[]; out: Record<number, string> }>((resolve, reject) => {
    const worker = new Worker(url, { type: "module" });
    const out: Record<number, string> = { 1: "", 2: "", 3: "" };
    const order: number[] = [];
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("timed out")); }, 180_000);
    worker.onmessage = ({ data }) => {
      if (data.type === "ready") {
        // Run 2 arrives while run 1 is still downloading pandas; run 3 needs numpy, which pandas already brought.
        worker.postMessage({ id: 1, type: "run", packages: ["pandas"], code: "import pandas as pd\nprint('one', pd.Series([1, 2]).sum())", tests: [] });
        worker.postMessage({ id: 2, type: "run", packages: [], code: "print('two')", tests: [] });
        worker.postMessage({ id: 3, type: "run", packages: ["numpy"], code: "import numpy as np\nprint('three', np.arange(3).sum())", tests: [] });
      }
      if (data.type === "stdout") out[data.id] += data.text;
      if (data.type === "result") {
        if (!data.result.ok) { clearTimeout(timer); worker.terminate(); reject(new Error(JSON.stringify(data))); return; }
        order.push(data.id);
        if (order.length === 3) { clearTimeout(timer); worker.terminate(); resolve({ order, out }); }
      }
    };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
  }), workerUrl);
  expect(seen.order).toEqual([1, 2, 3]);
  expect(seen.out).toEqual({ 1: "one 3", 2: "two", 3: "three 3" });
});
