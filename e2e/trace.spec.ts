import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import functions from "../content/lessons/py-functions.json" with { type: "json" };

// §5 "Show execution trace" on the learner's own code: the editor's current code, traced in the browser's Python.
test("an example traces the code in its editor, step by step, and editing clears the trace", async ({ page }) => {
  test.setTimeout(180_000);
  const at = functions.steps.findIndex((s) => s.kind === "example");
  const ex = functions.steps[at] as { code: string; expected_output: string };
  await page.goto(`./#/lesson/py-functions/${at}`);
  await page.getByRole("button", { name: "Show execution trace" }).click();
  const viewer = page.getByRole("region", { name: "Execution visualiser" });
  await expect(viewer).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".btn.primary:visible")).toHaveText(["Next →"]); // stepping a trace doesn't take the lead
  const step = viewer.getByRole("button", { name: "Step ▶" });
  await expect(viewer.locator(".trace-note")).toContainText("Step 1 of");
  while (await step.isEnabled()) await step.click();
  await expect(viewer.locator(".trace-note")).toContainText("The program has finished.");
  await expect(viewer.locator(".trace-out")).toHaveText(ex.expected_output.trimEnd());
  await expect(viewer.locator(".locals")).toContainText("function price_with_tax");
  await expect(viewer.locator(".stack li")).toHaveText(["<module>"]);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  await page.getByLabel("Example code").fill(ex.code + "\nprint('more')");
  await expect(viewer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show execution trace" })).toBeVisible();
});

test("an exercise traces the learner's draft, including a call's stack", async ({ page }) => {
  test.setTimeout(180_000);
  const at = functions.steps.findIndex((s) => s.kind === "guided");
  await page.goto(`./#/lesson/py-functions/${at}`);
  await page.locator("textarea.editor-input").fill("def double(n):\n    m = n * 2\n    return m\n\nprint(double(21))\n");
  await page.getByRole("button", { name: "Show execution trace" }).click();
  const viewer = page.getByRole("region", { name: "Execution visualiser" });
  await expect(viewer).toBeVisible({ timeout: 120_000 });
  const step = viewer.getByRole("button", { name: "Step ▶" });
  let sawCall = false;
  while (await step.isEnabled()) {
    await step.click();
    if ((await viewer.locator(".stack li").count()) === 2) {
      await expect(viewer.locator(".stack li").first()).toHaveText("double(21)");
      sawCall = true;
    }
  }
  expect(sawCall).toBe(true);
  await expect(viewer.locator(".trace-out")).toHaveText("42");
});

test("in the browser's Python too, an error leaving through finally is not a return", async ({ page }) => {
  test.setTimeout(180_000);
  const at = functions.steps.findIndex((s) => s.kind === "guided");
  await page.goto(`./#/lesson/py-functions/${at}`);
  await page.locator("textarea.editor-input").fill(
    "def cleanup():\n    try:\n        return 1 / 0\n    finally:\n        print('tidy')\n\ntry:\n    cleanup()\nexcept ZeroDivisionError:\n    print('caught')\n");
  await page.getByRole("button", { name: "Show execution trace" }).click();
  const viewer = page.getByRole("region", { name: "Execution visualiser" });
  await expect(viewer).toBeVisible({ timeout: 120_000 });
  const step = viewer.getByRole("button", { name: "Step ▶" });
  const notes: string[] = [];
  while (await step.isEnabled()) { await step.click(); notes.push(await viewer.locator(".trace-note").innerText()); }
  expect(notes.some((n) => n.includes("cleanup stops here: the error passes to its caller."))).toBe(true);
  expect(notes.some((n) => n.includes("cleanup returns"))).toBe(false);
  await expect(viewer.locator(".trace-out")).toHaveText("tidy\ncaught");
});

test("in the browser's Python, closing a paused generator reads as closed, not as another yield", async ({ page }) => {
  test.setTimeout(180_000);
  const at = functions.steps.findIndex((s) => s.kind === "guided");
  await page.goto(`./#/lesson/py-functions/${at}`);
  await page.locator("textarea.editor-input").fill("def gen():\n    yield 1\n    yield 2\n\ng = gen()\nprint(next(g))\ng.close()\n");
  await page.getByRole("button", { name: "Show execution trace" }).click();
  const viewer = page.getByRole("region", { name: "Execution visualiser" });
  await expect(viewer).toBeVisible({ timeout: 120_000 });
  const step = viewer.getByRole("button", { name: "Step ▶" });
  const notes: string[] = [];
  while (await step.isEnabled()) { await step.click(); notes.push(await viewer.locator(".trace-note").innerText()); }
  expect(notes.filter((n) => n.includes("yields")).length).toBe(1);
  expect(notes.some((n) => n.includes("gen is closed."))).toBe(true);
});
