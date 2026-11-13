import { expect, test } from "@playwright/test";
import caesar from "../content/lessons/proj-caesar.json" with { type: "json" };
import sim from "../content/lessons/stats-simulation.json" with { type: "json" };
import vectors from "../content/lessons/ml-vectors.json" with { type: "json" };
import summary from "../content/lessons/stats-summary.json" with { type: "json" };
import regression from "../content/lessons/ml-linear-regression.json" with { type: "json" };
import evaluation from "../content/lessons/ml-evaluation.json" with { type: "json" };
import classification from "../content/lessons/ml-classification.json" with { type: "json" };
import capstone from "../content/lessons/ml-capstone.json" with { type: "json" };
import scaling from "../content/lessons/ml-scaling.json" with { type: "json" };
import pca from "../content/lessons/ml-pca.json" with { type: "json" };
import kmeans from "../content/lessons/ml-kmeans.json" with { type: "json" };
import normal from "../content/lessons/stats-normal.json" with { type: "json" };
import knn from "../content/lessons/ml-knn.json" with { type: "json" };
import logistic from "../content/lessons/ml-logistic.json" with { type: "json" };
import trees from "../content/lessons/ml-trees.json" with { type: "json" };
import life from "../content/lessons/proj-life.json" with { type: "json" };
import forests from "../content/lessons/ml-forests.json" with { type: "json" };
import matrices from "../content/lessons/ml-matrices.json" with { type: "json" };
import derivatives from "../content/lessons/ml-derivatives.json" with { type: "json" };
import bayes from "../content/lessons/stats-bayes.json" with { type: "json" };
import monty from "../content/lessons/proj-monty-hall.json" with { type: "json" };
import boosting from "../content/lessons/ml-boosting.json" with { type: "json" };
import jsoncsv from "../content/lessons/py-json-csv.json" with { type: "json" };
import typing from "../content/lessons/py-typing.json" with { type: "json" };
import complexity from "../content/lessons/algo-complexity.json" with { type: "json" };
import testing from "../content/lessons/py-testing.json" with { type: "json" };
import generators from "../content/lessons/py-generators.json" with { type: "json" };

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
  ["ml-classification", classification, "centroids", ["linear", "nearest"]],
  ["ml-capstone", capstone, "inspect", ["load", "pipeline"]],
  ["ml-scaling", scaling, "units", ["standardize", "model"]],
  ["ml-pca", pca, "cigar", ["covariance", "pca"]],
  ["ml-kmeans", kmeans, "starts", ["assign", "kmeans"]],
  ["stats-normal", normal, "heights", ["pdf", "probabilities"]],
  ["ml-knn", knn, "pick", ["knn", "choose"]],
  ["ml-logistic", logistic, "fit", ["probs", "train"]],
  ["ml-trees", trees, "scan", ["split", "grow"]],
  ["proj-life", life, "count", ["next", "cycle"]],
  ["ml-forests", forests, "draw", ["sample", "forest"]],
  ["ml-matrices", matrices, "solve-it", ["multiply", "eliminate"]],
  ["ml-derivatives", derivatives, "steps", ["estimate", "verify"]],
  ["stats-bayes", bayes, "test", ["condition", "classify"]],
  ["proj-monty-hall", monty, "doors", ["simulate", "exact"]],
  ["ml-boosting", boosting, "rounds", ["stump", "boost"]],
  ["py-json-csv", jsoncsv, "round-trip", ["read", "report"]],
  ["py-typing", typing, "hints", ["item", "cart"]],
  ["algo-complexity", complexity, "searching", ["growth", "common"]],
  ["py-testing", testing, "run-tests", ["testcase", "debug", "median"]],
  ["py-generators", generators, "squares", ["running", "pipeline"]],
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
