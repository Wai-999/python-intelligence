import { expect, test } from "@playwright/test";
import caesar from "../content/lessons/proj-caesar.json" with { type: "json" };
import sim from "../content/lessons/stats-simulation.json" with { type: "json" };
import vectors from "../content/lessons/ml-vectors.json" with { type: "json" };
import summary from "../content/lessons/stats-summary.json" with { type: "json" };
import regression from "../content/lessons/ml-linear-regression.json" with { type: "json" };
import evaluation from "../content/lessons/ml-evaluation.json" with { type: "json" };

// The lessons that combine all five books (and the statistics/ML path built on them): each runs in the browser exactly as the CPython 3.12 gate checked it.
type L = { steps: { id: string; kind: string; code?: string; expected_output?: string; solution?: string }[] };
const at = (l: L, id: string) => l.steps.findIndex((s) => s.id === id);

test("the library shelf lists every book, marks reference-only ones and links to lessons", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("link", { name: "Library" }).click();
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeFocused();
  const books = page.locator(".shelf").first().locator(":scope > .shelf-item");
  await expect(books).toHaveCount(5);
  await expect(page.locator(".tag", { hasText: "reference only" })).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator(".shelf-item", { hasText: "Mathematics for Machine Learning" })
    .getByRole("link", { name: "Vectors: length, distance and similarity" }).click();
  await expect(page).toHaveURL(/#\/lesson\/ml-vectors\/0$/);
});

for (const [name, lesson, example, exercises] of [
  ["proj-caesar", caesar, "round-trip", ["decrypt", "crack"]],
  ["stats-simulation", sim, "dice", ["birthday", "estimate"]],
  ["ml-vectors", vectors, "measure", ["cosine", "nearest"]],
  ["stats-summary", summary, "classes", ["std", "outliers"]],
  ["ml-linear-regression", regression, "fit", ["closed", "descent"]],
  ["ml-evaluation", evaluation, "memoriser", ["split", "kfold"]],
] as const) {
  test(`${name}: example output and every exercise solution pass in the browser`, async ({ page }) => {
    test.setTimeout(240_000);
    const l = lesson as L;
    await page.goto(`./#/lesson/${name}/${at(l, example)}`);
    await page.getByRole("button", { name: "▶ Run", exact: true }).click();
    await expect(page.locator(".console pre").first()).toHaveText(l.steps[at(l, example)]!.expected_output!, { timeout: 180_000 });
    for (const id of exercises) {
      await page.goto(`./#/lesson/${name}/${at(l, id)}`);
      await page.locator("textarea.editor-input").fill(l.steps[at(l, id)]!.solution!);
      await page.getByRole("button", { name: "▶ Run checks" }).click();
      await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
    }
  });
}
