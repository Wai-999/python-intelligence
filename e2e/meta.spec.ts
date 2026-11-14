import { expect, test } from "@playwright/test";
import type { ExerciseStep, Lesson } from "../src/content/types";
import pending from "../content/pending_meta.json" with { type: "json" };

// Every lesson with its G-5 metadata: the transfer solution passes in the browser, and the metadata is shown.
import valuesNames from "../content/lessons/py-values-names.json" with { type: "json" };

const all = Object.values(await (async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.resolve("content/lessons");
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => [f, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Lesson]));
})());
const done = all.filter((l) => !(pending as { lessons: string[] }).lessons.includes(l.id));

for (const lesson of done) {
  test(`${lesson.id}: the transfer problem's solution passes in the browser`, async ({ page }) => {
    test.setTimeout(240_000);
    const at = lesson.steps.findIndex((s) => s.kind === "transfer");
    expect(at).toBeGreaterThan(0);
    await page.goto(`./#/lesson/${lesson.id}/${at}`);
    await expect(page.getByRole("region", { name: "Transfer problem" })).toBeVisible();
    await expect(page.locator("p.difficulty")).toHaveText(/^Difficulty: (Core|Stretch)/);
    await page.locator("textarea.editor-input").fill((lesson.steps[at] as ExerciseStep).solution);
    await page.getByRole("button", { name: "▶ Run checks" }).click();
    await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 180_000 });
  });
}

test("the goal, analogy, common mix-ups and self-check rubric appear on their steps", async ({ page }) => {
  const l = valuesNames as unknown as Lesson;
  const at = (...kinds: string[]) => kinds.map((k) => l.steps.findIndex((s) => s.kind === k)).find((i) => i >= 0)!;
  await page.goto(`./#/lesson/${l.id}/${at("motivation")}`);
  await expect(page.locator("p.objective")).toContainText(l.objective!.slice(0, 30));
  await page.goto(`./#/lesson/${l.id}/${at("intuition", "motivation")}`);
  await expect(page.locator("p.analogy")).toContainText("label on a jar");
  await page.goto(`./#/lesson/${l.id}/${at("formal", "example")}`); // this lesson has no formal step
  await page.locator("details.misconceptions summary").click();
  await expect(page.locator("details.misconceptions li")).toHaveCount(l.misconceptions!.length);
  await page.goto(`./#/lesson/${l.id}/${at("summary")}`);
  await expect(page.getByRole("region", { name: "Check your own work" }).locator("li")).toHaveCount(l.rubric!.length);
});

test("a due review starts with the lesson's free-recall prompt", async ({ page }) => {
  const l = valuesNames as unknown as Lesson;
  const T0 = new Date("2026-03-02T09:00:00Z");
  await page.clock.install({ time: T0 });
  const iso = (h: number) => new Date(T0.getTime() + h * 3600_000).toISOString();
  const events = [["circle", "exercise"], ["bill", "exercise"], ["check", "quiz"]].map(([stepId, task], i) =>
    ({ id: `e${i}`, at: iso(-3 + i * 0.01), lessonId: l.id, stepId, task, concept: "names", passed: true, assistance: 0, policy: "learner-heuristic-1" }));
  await page.goto("./#/review");
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "h.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(
    { format: "python-intelligence-progress", version: 2, exportedAt: iso(0), lessons: [], drafts: {}, position: null, assistance: {}, events })) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.clock.setSystemTime(new Date(T0.getTime() + 25 * 3600_000));
  await page.goto("./#/");
  await page.goto("./#/review");
  await expect(page.locator("p.recall")).toContainText(l.review!.recall.slice(0, 25));
});

test("in the browser, lesson 1's transfer traces the code that runs: hard-coded values fail only the structure check", async ({ page }) => {
  test.setTimeout(240_000);
  const l = valuesNames as unknown as Lesson;
  const at = l.steps.findIndex((s) => s.kind === "transfer");
  await page.goto(`./#/lesson/${l.id}/${at}`);
  await page.locator("textarea.editor-input").fill("price = 2.5\ncount = 4\nif False:\n    subtotal = price * count\nsubtotal = 10.0\ntax = 2.0\ntotal = 12.0\nprint(total)\n");
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  const failed = page.locator(".checks li.fail");
  await expect(failed).toHaveCount(1, { timeout: 180_000 });
  await expect(failed).toContainText("computed from the names before it");
  await expect(page.locator(".console pre").first()).toHaveText("12.0\n"); // the traced re-run printed nothing extra
});
