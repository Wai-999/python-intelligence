import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ExerciseStep, Lesson } from "../src/content/types";
import { buildModel, type LearnerEvent } from "../src/learner/model";
import { creditedConcepts } from "../src/learner/record";
import valuesNames from "../content/lessons/py-values-names.json" with { type: "json" };
import functionsLesson from "../content/lessons/py-functions.json" with { type: "json" };

const functionsQuiz = (functionsLesson as unknown as { steps: { kind: string; questions?: { id: string; answer: number }[] }[] }).steps.find((s) => s.kind === "quiz")! as { questions: { id: string; answer: number }[] };

// Exercise state belongs to one task of one lesson, survives imports correctly, and one run is one attempt.

type L = { steps: { id: string; kind: string; solution?: string; hints?: string[] }[] };
const lesson = valuesNames as unknown as L;
const circle = lesson.steps.findIndex((s) => s.id === "circle");

async function exportEvents(page: Page) {
  await page.getByRole("button", { name: "Progress" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export progress" }).click();
  const file = await (await download).path();
  const data = JSON.parse(readFileSync(file, "utf8"));
  await page.getByRole("button", { name: "Close" }).click();
  return data as { events: { stepId: string; assistance: number }[] };
}

test("help shown in one lesson's step doesn't carry into another lesson's step with the same id", async ({ page }) => {
  await page.goto("./#/lesson/ml-evaluation/5");
  await page.getByRole("button", { name: /Show a hint/ }).click();
  await expect(page.locator(".hint")).toHaveCount(1);
  await page.goto("./#/lesson/ml-trees/5"); // also a step called "split"
  await expect(page.getByRole("heading", { name: /Gini and the best split/ })).toBeVisible();
  await expect(page.locator(".hint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Show a hint/ })).toBeVisible();
});

test("importing progress into an open exercise shows and counts the imported help", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`./#/lesson/py-values-names/${circle}`);
  await expect(page.locator(".solution")).toHaveCount(0);
  const file = { format: "python-intelligence-progress", version: 2, exportedAt: "2026-03-02T09:00:00.000Z", lessons: [], drafts: {},
    position: null, events: [], assistance: { "py-values-names:circle": 4 } };
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "p.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("One correct solution")).toBeVisible();
  await page.locator("textarea.editor-input").fill(lesson.steps[circle]!.solution!);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
  const { events } = await exportEvents(page);
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((e) => e.stepId === "circle" && e.assistance === 4)).toBe(true);
});

test("pressing the run shortcut repeatedly during a run records one attempt", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`./#/lesson/py-values-names/${circle}`);
  const editor = page.locator("textarea.editor-input");
  await editor.fill(lesson.steps[circle]!.solution!);
  await editor.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(500);
  const { events } = await exportEvents(page);
  const ids = new Set(events.map((e) => e.stepId));
  expect([...ids]).toEqual(["circle"]);
  // One run records one event per concept it is credited to (three here), not one batch per key press.
  expect(events.length).toBe(creditedConcepts(valuesNames as unknown as Lesson, (valuesNames as unknown as Lesson).steps[circle] as ExerciseStep).length);
});

test("a run still going when progress is reset can't write into the fresh progress", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`./#/lesson/py-values-names/${circle}`);
  const slow = `${lesson.steps[circle]!.solution!}\nimport time\n_t = time.time()\nwhile time.time() - _t < 4:\n    pass\n`;
  await page.locator("textarea.editor-input").fill(slow);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await page.getByRole("button", { name: "Progress" }).click();
  await page.getByRole("button", { name: "Reset…" }).click();
  await page.getByRole("button", { name: "Erase everything" }).click();
  await expect(page.getByText("Progress reset.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(8000); // the slow run finishes in the meantime
  const data = await exportEvents(page) as unknown as { events: unknown[]; lessons: { steps: Record<string, unknown> }[] };
  expect(data.events).toEqual([]);
  expect(data.lessons.every((l) => !("circle" in l.steps))).toBe(true);
});

test("an import while review feedback is showing starts the review over, and reviews rotate through a concept's questions", async ({ page }) => {
  test.setTimeout(120_000);
  const T0 = new Date("2026-03-02T09:00:00Z");
  await page.clock.install({ time: T0 });
  const iso = (h: number) => new Date(T0.getTime() + h * 3600_000).toISOString();
  const evidence = (lessonId: string, concept: string, n: number) => [["a", "exercise"], ["b", "exercise"], ["check", "quiz"]].map(([stepId, task], i) =>
    ({ id: `${concept}-${i}`, at: iso(-3 + n * 0.01 + i * 0.001), lessonId, stepId, task, concept, passed: true, assistance: 0, policy: "learner-heuristic-1" }));
  const history = { format: "python-intelligence-progress", version: 2, exportedAt: iso(0), lessons: [], drafts: {}, position: null, assistance: {},
    events: [...["values", "names", "expressions", "print"].flatMap((c, k) => evidence("py-values-names", c, k)), ...evidence("py-functions", "functions", 5),
      // The prerequisite concepts are reviewed on time (day 1 and day 4), so only functions is due at each check below.
      ...["values", "names", "expressions", "print"].flatMap((c) => [21, 93].map((h, i) => ({ id: `${c}-review-${i}`, at: iso(h), lessonId: "py-values-names",
        stepId: "review:q", task: "review", concept: c, passed: true, assistance: 0, policy: "learner-heuristic-1" })))] };
  const load = async () => {
    await page.getByRole("button", { name: "Progress" }).click();
    await page.locator("input[type=file]").setInputFiles({ name: "h.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(history)) });
    await expect(page.getByText("Progress imported.")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
  };
  await page.goto("./#/review");
  await load();
  await page.clock.setSystemTime(new Date(T0.getTime() + 22 * 3600_000));
  await page.goto("./#/");
  await page.goto("./#/review");
  const form = page.locator("form.quiz");
  await expect(page.getByText(/· functions ·/)).toBeVisible();
  const first = await form.locator("legend").innerText();
  await form.locator("input[type=radio]").first().check();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(form.getByRole("status")).toBeVisible();
  await load(); // replace the history while the feedback is still on screen
  await expect(form.getByRole("status")).toHaveCount(0);
  await expect(form.locator("legend")).toHaveText(first); // the same first question, from a clean start
  // Answer it correctly this time, then the next review (3 days on) asks the other functions question.
  const questions = [
    { text: "How many times does the body", answer: (functionsQuiz.questions.find((q) => q.id === "q2")!).answer },
    { text: "What happens on the last line", answer: (functionsQuiz.questions.find((q) => q.id === "q3")!).answer },
  ];
  const pick = (legend: string) => questions.find((q) => legend.includes(q.text))!;
  await form.locator("input[type=radio]").nth(pick(first).answer).check();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(form.getByRole("status")).toContainText("Correct.");
  await page.clock.setSystemTime(new Date(T0.getTime() + (22 + 73) * 3600_000));
  await page.goto("./#/");
  await page.goto("./#/review");
  await expect(page.getByText(/· functions ·/)).toBeVisible();
  const second = await form.locator("legend").innerText();
  expect(pick(second).text).not.toBe(pick(first).text);
});

test("after a rejected import, practice is still recorded", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`./#/lesson/py-values-names/${circle}`);
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "bad.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "python-intelligence-progress", version: 2, exportedAt: "nope" })) });
  await expect(page.getByText(/Import failed/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.locator("textarea.editor-input").fill(lesson.steps[circle]!.solution!);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(500);
  const data = await exportEvents(page) as unknown as { events: { stepId: string }[]; lessons: { lessonId: string; steps: Record<string, { passed: boolean }> }[] };
  expect(data.events.length).toBe(creditedConcepts(valuesNames as unknown as Lesson, (valuesNames as unknown as Lesson).steps[circle] as ExerciseStep).length);
  expect(data.lessons.find((l) => l.lessonId === "py-values-names")?.steps.circle?.passed).toBe(true);
});

test("a quiz retried after its answers were revealed can't serve as the explanation check", async ({ page }) => {
  const quiz = (valuesNames as unknown as { steps: { id: string; kind: string; questions?: { answer: number; choices: string[] }[] }[] }).steps;
  const at = quiz.findIndex((s) => s.kind === "quiz");
  const questions = quiz[at]!.questions!;
  await page.goto(`./#/lesson/py-values-names/${at}`);
  const sets = page.locator("fieldset.question");
  for (let i = 0; i < questions.length; i++) await sets.nth(i).locator("input[type=radio]").nth((questions[i]!.answer + 1) % questions[i]!.choices.length).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(page.getByText(/You need/)).toBeVisible();
  await page.waitForTimeout(500); // let IndexedDB finish writing
  await page.reload(); // the answers stay "seen" across a reload
  await page.goto(`./#/lesson/py-values-names/${at}`);
  for (let i = 0; i < questions.length; i++) await sets.nth(i).locator("input[type=radio]").nth(questions[i]!.answer).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(page.getByText(/Passed!/)).toBeVisible();
  await page.waitForTimeout(300);
  const { events } = await exportEvents(page) as unknown as { events: LearnerEvent[] };
  const [firstAt, secondAt] = [...new Set(events.map((e) => e.at))].sort();
  expect(events.filter((e) => e.at === firstAt).every((e) => e.assistance === 0 && !e.passed)).toBe(true);
  expect(events.filter((e) => e.at === secondAt).every((e) => e.assistance === 4)).toBe(true);
  const model = buildModel([valuesNames as unknown as Lesson], events);
  for (const c of ["names", "expressions", "values"]) expect(model.concepts.get(c)!.explanationChecked).toBe(false);
});

const quizSteps = (valuesNames as unknown as { steps: { id: string; kind: string; questions?: { answer: number; choices: string[] }[] }[] }).steps;
const quizAt = quizSteps.findIndex((s) => s.kind === "quiz");
const quizQs = quizSteps[quizAt]!.questions!;
async function submitQuiz(page: Page, right: boolean) {
  const sets = page.locator("fieldset.question");
  for (let i = 0; i < quizQs.length; i++)
    await sets.nth(i).locator("input[type=radio]").nth(right ? quizQs[i]!.answer : (quizQs[i]!.answer + 1) % quizQs[i]!.choices.length).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(page.getByText(right ? /Passed!/ : /You need/)).toBeVisible();
  await page.waitForTimeout(500);
}

test("a second tab opened before the answers were revealed still counts its submission as assisted", async ({ page, context }) => {
  await page.goto(`./#/lesson/py-values-names/${quizAt}`);
  const other = await context.newPage();
  await other.goto(`./#/lesson/py-values-names/${quizAt}`);
  await submitQuiz(page, false); // reveals the answers in the first tab
  await submitQuiz(other, true); // the second tab never saw that happen
  const { events } = await exportEvents(other) as unknown as { events: LearnerEvent[] };
  const passed = events.filter((e) => e.passed);
  expect(passed.length).toBeGreaterThan(0);
  expect(passed.every((e) => e.assistance === 4)).toBe(true);
  const model = buildModel([valuesNames as unknown as Lesson], events);
  for (const c of ["names", "expressions", "values"]) expect(model.concepts.get(c)!.explanationChecked).toBe(false);
});

test("a quiz attempted in a version 1 backup counts as revealed after import", async ({ page }) => {
  await page.goto(`./#/lesson/py-values-names/${quizAt}`);
  const v1 = { format: "python-intelligence-progress", version: 1, exportedAt: "2026-03-01T09:00:00.000Z", drafts: {}, position: null,
    lessons: [{ lessonId: "py-values-names", steps: { check: { passed: false, attempts: 1, score: 0, updatedAt: "2026-03-01T09:00:00.000Z" } },
      furthestStep: quizAt, completed: false, mastery: 0, struggles: {} }] };
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "v1.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(v1)) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await submitQuiz(page, true);
  const { events } = await exportEvents(page) as unknown as { events: LearnerEvent[] };
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((e) => e.assistance === 4)).toBe(true);
});

test("the Review page keeps keyboard focus in place across two due questions", async ({ page }) => {
  const T0 = new Date("2026-03-02T09:00:00Z");
  await page.clock.install({ time: T0 });
  const iso = (h: number) => new Date(T0.getTime() + h * 3600_000).toISOString();
  const events = ["names", "expressions"].flatMap((concept, k) => [["a", "exercise"], ["b", "exercise"], ["check", "quiz"]].map(([stepId, task], i) =>
    ({ id: `${concept}-${i}`, at: iso(-3 + k * 0.01 + i * 0.001), lessonId: "py-values-names", stepId, task, concept, passed: true, assistance: 0, policy: "learner-heuristic-1" })));
  await page.goto("./#/review");
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "h.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(
    { format: "python-intelligence-progress", version: 2, exportedAt: iso(0), lessons: [], drafts: {}, position: null, assistance: {}, events })) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.clock.setSystemTime(new Date(T0.getTime() + 22 * 3600_000));
  await page.goto("./#/");
  await page.goto("./#/review");
  await expect(page.locator(":focus")).toHaveText("Review");
  const form = page.locator("form.quiz");
  for (const [left, button] of [["2 due", "Next review"], ["1 due", "Done"]] as const) {
    await expect(form.locator(".eyebrow")).toContainText(left);
    await form.locator("input[type=radio]").first().focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter"); // submits the form
    await expect(form.getByRole("status")).toBeVisible();
    await page.getByRole("button", { name: button }).press("Enter");
    if (button === "Next review") await expect(page.locator(":focus")).toContainText("1 due");
  }
  await expect(page.locator(":focus")).toHaveText("Nothing is due for review right now.");
});

test("importing progress while a quiz shows its feedback starts the quiz over", async ({ page }) => {
  await page.goto(`./#/lesson/py-values-names/${quizAt}`);
  await submitQuiz(page, false);
  await expect(page.getByText(/You need/)).toBeVisible();
  const empty = { format: "python-intelligence-progress", version: 2, exportedAt: "2026-03-01T09:00:00.000Z", lessons: [], drafts: {}, position: null, events: [], assistance: {} };
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "e.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(empty)) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText(/You need/)).toHaveCount(0);
  await expect(page.locator("fieldset.question input[type=radio]:checked")).toHaveCount(0); // a fresh, unanswered quiz
});

for (const kind of ["reset", "import"] as const) {
  test(`a run still going in one tab when another tab ${kind}s progress can't write into the replacement`, async ({ page, context }) => {
    test.setTimeout(180_000);
    await page.goto(`./#/lesson/py-values-names/${circle}`);
    const slow = `${lesson.steps[circle]!.solution!}\nimport time\n_t = time.time()\nwhile time.time() - _t < 4:\n    pass\n`;
    await page.locator("textarea.editor-input").fill(slow);
    await page.getByRole("button", { name: "▶ Run checks" }).click();
    const other = await context.newPage();
    await other.goto("./#/");
    await other.getByRole("button", { name: "Progress" }).click();
    if (kind === "reset") {
      await other.getByRole("button", { name: "Reset…" }).click();
      await other.getByRole("button", { name: "Erase everything" }).click();
      await expect(other.getByText("Progress reset.")).toBeVisible();
    } else {
      const empty = { format: "python-intelligence-progress", version: 2, exportedAt: "2026-03-01T09:00:00.000Z", lessons: [], drafts: {}, position: null, events: [], assistance: {} };
      await other.locator("input[type=file]").setInputFiles({ name: "e.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(empty)) });
      await expect(other.getByText("Progress imported.")).toBeVisible();
    }
    await other.getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(9000); // the first tab's slow run finishes meanwhile
    await expect(page.getByText(/Progress can't be saved/)).toHaveCount(0); // it reloaded instead of erroring
    const data = await exportEvents(other) as unknown as { events: unknown[]; lessons: { steps: Record<string, unknown> }[] };
    expect(data.events).toEqual([]);
    expect(data.lessons.every((l) => !("circle" in l.steps))).toBe(true);
  });
}

test("an import in one tab shows up in another open tab without it writing anything", async ({ page, context }) => {
  await page.goto("./#/");
  await expect(page.locator(".overall")).toContainText("0/");
  const other = await context.newPage();
  await other.goto("./#/");
  // A real completion: every graded step passed (the app re-judges stored completion against the lesson's steps).
  const at = "2026-03-01T09:00:00.000Z";
  const steps = Object.fromEntries((valuesNames as unknown as Lesson).steps.filter((s) => ["guided", "challenge", "transfer", "quiz"].includes(s.kind))
    .map((s) => [s.id, { passed: true, attempts: 1, updatedAt: at, ...(s.kind === "quiz" ? { score: 1 } : {}) }]));
  const done = { lessonId: "py-values-names", steps, furthestStep: 0, completed: true, completedAt: at, mastery: 1, struggles: {} };
  const file = { format: "python-intelligence-progress", version: 2, exportedAt: "2026-03-01T09:00:00.000Z", lessons: [done], drafts: {}, position: null, events: [], assistance: {} };
  await other.getByRole("button", { name: "Progress" }).click();
  await other.locator("input[type=file]").setInputFiles({ name: "p.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(other.getByText("Progress imported.")).toBeVisible();
  await expect(page.locator(".overall")).toContainText("1/"); // told by the other tab's broadcast
});
