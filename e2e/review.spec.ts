import { expect, test, type Page } from "@playwright/test";
import valuesNames from "../content/lessons/py-values-names.json" with { type: "json" };

// Master prompt §5 end to end, in a real browser with a fake clock: practice is recorded as learner events, a completed
// concept comes back for review after a day, a correct review spaces it further, and a lapse starts the spacing again.
// Most concepts still need a second exercise (task G-5) to reach the gate by practice alone, so the completing history
// is imported through the app's own Progress → Import, which validates it exactly like any backup.

type Q = { prompt: string; answer: number; concept: string };
type L = { steps: { id: string; kind: string; solution?: string; questions?: Q[] }[] };
const lesson = valuesNames as unknown as L;
const at = (id: string) => lesson.steps.findIndex((s) => s.id === id);
const questions = lesson.steps.flatMap((s) => s.questions ?? []);
const T0 = new Date("2026-03-02T09:00:00Z");
const iso = (hours: number) => new Date(T0.getTime() + hours * 3600_000).toISOString();

const history = {
  format: "python-intelligence-progress", version: 2, exportedAt: iso(0), lessons: [], drafts: {}, position: null,
  events: [
    ["circle", "exercise", 0], ["practice-2", "exercise", 0.5], ["check", "quiz", 1],
  ].map(([stepId, task, h], i) => ({ id: `seed-${i}`, at: iso((h as number) - 3), lessonId: "py-values-names", stepId, task,
    concept: "names", passed: true, assistance: 0, policy: "learner-heuristic-1" })),
};

async function answerReview(page: Page, right: boolean) {
  const form = page.locator("form.quiz");
  const legend = await form.locator("legend").innerText();
  const q = questions.find((x) => legend.includes(x.prompt.replace(/`/g, "").slice(0, 24)))!;
  await form.locator("input[type=radio]").nth(right ? q.answer : (q.answer + 1) % 2).check();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.getByRole("status")).toContainText(right ? "Correct." : "Not quite.");
  await page.getByRole("button", { name: /Done|Next review/ }).click();
}
const badge = (page: Page) => page.getByRole("link", { name: /^Review/ }).locator(".badge");

test("practice is recorded, a completed concept comes back after a day, and the spacing grows or resets", async ({ page }) => {
  test.setTimeout(240_000);
  await page.clock.install({ time: T0 });

  // Real practice in the browser becomes learner events, and help is remembered: fail twice, reveal the solution,
  // leave, come back, and pass. The pass counts as assisted (5%), not independent (25%).
  const circle = `./#/lesson/py-values-names/${at("circle")}`;
  await page.goto(circle);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "▶ Run checks" }).click();
    await expect(page.locator(".checks li.fail").first()).toBeVisible({ timeout: 120_000 });
  }
  await page.getByRole("button", { name: "Show the solution…" }).click();
  await page.getByRole("button", { name: "Show it anyway" }).click();
  await page.goto("./#/");
  await page.goto(circle);
  await expect(page.getByText("One correct solution")).toBeVisible(); // restored on return
  await page.locator("textarea.editor-input").fill(lesson.steps[at("circle")]!.solution!);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
  await page.goto("./#/review");
  await expect(page.getByRole("row", { name: /^names/ }).locator("td").nth(2)).toHaveText(/^5% /);

  // Import a history in which "names" has two independent exercises and an explanation check.
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "history.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(history)) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  const names = page.getByRole("row", { name: /^names/ });
  await expect(names).toContainText("complete (reviews pending)");
  await expect(page.getByText("Nothing is due for review right now.")).toBeVisible();
  await expect(badge(page)).toHaveCount(0);

  // The badge appears by itself when the deadline passes, with no navigation (it fell due at 22:00 after T0).
  await page.clock.fastForward("23:00:00");
  await expect(badge(page)).toHaveText("1");

  // A day later, after a reload (events come back from IndexedDB), the review is due.
  await page.clock.setSystemTime(new Date(T0.getTime() + 24 * 3600_000));
  await page.reload();
  await page.goto("./#/review");
  await expect(badge(page)).toHaveText("1");
  await expect(page.getByText(/1 due · names/)).toBeVisible();
  await answerReview(page, true);
  await expect(page.getByText("Nothing is due for review right now.")).toBeVisible();
  await expect(badge(page)).toHaveCount(0);

  // Two days later it isn't due yet (the next gap is 3 days); a day after that it is, and a wrong answer is a lapse.
  await page.clock.setSystemTime(new Date(T0.getTime() + 72 * 3600_000));
  await page.goto("./#/");
  await page.goto("./#/review");
  await expect(page.getByText("Nothing is due for review right now.")).toBeVisible();
  await page.clock.setSystemTime(new Date(T0.getTime() + 97 * 3600_000));
  await page.goto("./#/");
  await page.goto("./#/review");
  await answerReview(page, false);
  await expect(names).toContainText("complete (reviews pending)");
  await page.clock.setSystemTime(new Date(T0.getTime() + 122 * 3600_000));
  await page.goto("./#/");
  await page.goto("./#/review");
  await expect(page.getByText(/1 due · names/)).toBeVisible();
});
