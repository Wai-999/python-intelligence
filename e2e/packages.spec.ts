import { expect, test } from "@playwright/test";

test("lesson packages load before examples and exercise checks; pandas is supported", async ({ page }) => {
  test.setTimeout(240_000);
  let workerUrl = "";
  page.on("request", (request) => {
    if (/\/assets\/worker-[^/]+\.js$/.test(new URL(request.url()).pathname)) workerUrl = request.url();
  });
  await page.goto("./#/lesson/np-arrays/4");
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect(page.locator(".console pre").first()).toContainText("(2, 3)", { timeout: 120_000 });
  await expect(page.locator(".console-error")).toHaveCount(0);
  // A second run reuses the loaded package in the same interpreter.
  await page.getByRole("button", { name: "▶ Run", exact: true }).click();
  await expect(page.locator(".console pre").first()).toContainText("(2, 3)");
  await page.goto("./#/lesson/np-arrays/5");
  await page.locator("textarea.editor-input").fill(
    "import numpy as np\ndef above_average(values):\n    arr = np.array(values)\n    return arr[arr > arr.mean()]\n",
  );
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible();

  // There is no pandas lesson yet: exercise the production worker protocol directly.
  expect(workerUrl).not.toBe("");
  const output = await page.evaluate((url) => new Promise<string>((resolve, reject) => {
    const worker = new Worker(url, { type: "module" });
    let stdout = "";
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("Package run timed out")); }, 120_000);
    worker.onmessage = ({ data }) => {
      if (data.type === "ready") worker.postMessage({ id: 1, type: "run", packages: ["pandas"],
        code: "import pandas as pd\nprint(pd.Series([2, 4, 6]).sum())", tests: [] });
      if (data.type === "stdout") stdout += data.text;
      if (data.type === "result" || data.type === "load-error") {
        clearTimeout(timer);
        worker.terminate();
        if (data.result?.ok) resolve(stdout);
        else reject(new Error(JSON.stringify(data)));
      }
    };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
  }), workerUrl);
  expect(output).toBe("12");
});
