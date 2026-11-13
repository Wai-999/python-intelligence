import { expect, test } from "@playwright/test";
import type { ExerciseStep, Lesson } from "../src/content/types";
import { creditedConcepts } from "../src/learner/record";
import valuesNames from "../content/lessons/py-values-names.json" with { type: "json" };

const lesson = valuesNames as unknown as Lesson;
const at = lesson.steps.findIndex((s) => s.id === "circle");
const step = lesson.steps[at] as ExerciseStep;

test("suggested hints fade after independent successes and come back after repeated failed runs", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`./#/lesson/py-values-names/${at}`);
  const note = page.getByRole("note");
  await expect(note).toHaveText(new RegExp(`^Suggested support: up to ${Math.min(2, step.hints.length)} hint`)); // a new learner

  // Two independent passes of this exercise on every concept it is credited to: support eases off by one tier.
  const T = Date.now() - 3600_000;
  const events = [0, 1].flatMap((n) => creditedConcepts(lesson, step).map((concept, i) => ({ id: `p${n}-${i}`, at: new Date(T + n * 60_000 + i).toISOString(),
    lessonId: lesson.id, stepId: step.id, task: "exercise", concept, passed: true, assistance: 0, policy: "learner-heuristic-1" })));
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "h.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(
    { format: "python-intelligence-progress", version: 2, exportedAt: new Date().toISOString(), lessons: [], drafts: {}, position: null, assistance: {}, events })) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(note).toHaveText(/^Suggested support: up to 1 hint, fewer than at first/);
  await expect(page.getByRole("button", { name: /Show a hint/ })).toHaveText(/\(suggested, \d+ left\)/);

  // Two failed runs restore a tier for this task; explicit help was available throughout.
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "▶ Run checks" }).click();
    await expect(page.locator(".checks li.fail").first()).toBeVisible({ timeout: 120_000 });
  }
  await expect(note).toHaveText(/raised after repeated tries/);
});
