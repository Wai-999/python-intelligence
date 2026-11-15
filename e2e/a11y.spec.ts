import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { ExerciseStep, Lesson } from "../src/content/types";
import valuesNames from "../content/lessons/py-values-names.json" with { type: "json" };
import conditionals from "../content/lessons/py-conditionals.json" with { type: "json" };
import diagnostic from "../content/diagnostic.json" with { type: "json" };

// Automated WCAG 2.1 A/AA checks (axe-core) on every distinct page state, in light and dark colour schemes.
// Automated checks find roughly a third of accessibility problems; they complement, not replace, manual review.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function scan(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = r.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `${label}: accessibility violations`).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test(`home, prose, trace, quiz, recap and progress panel have no WCAG A/AA violations (${scheme})`, async ({ page }) => {
      await page.goto("./");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await scan(page, "home");

      await page.goto("./#/library");
      await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
      await scan(page, "library");

      await page.goto("./#/lesson/py-conditionals/1");
      await expect(page.getByRole("heading", { name: "A comparison is a question" })).toBeVisible();
      await scan(page, "intuition step with sources and look-ahead notice");

      await page.goto("./#/lesson/py-conditionals/2");
      await page.getByRole("button", { name: "Step ▶" }).click();
      await scan(page, "call-trace viewer");

      await page.goto("./#/lesson/py-conditionals/8");
      await expect(page.locator("fieldset.question").first()).toBeVisible();
      await scan(page, "quiz");

      await page.goto("./#/lesson/py-conditionals/9");
      await expect(page.getByRole("region", { name: "Further reading" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Check your own work" })).toBeVisible();
      await scan(page, "recap with further reading");

      const trigger = page.getByRole("button", { name: "Progress" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Your progress" })).toBeFocused();
      await scan(page, "progress panel");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.press("Enter");
      await page.getByRole("button", { name: "Close" }).click();
      await expect(trigger).toBeFocused();
    });

    test(`example output and failed checks with the tutor note have no violations (${scheme})`, async ({ page }) => {
      await page.goto("./#/lesson/py-values-names/2");
      await page.getByRole("button", { name: "▶ Run" }).click();
      await expect(page.locator(".console pre").first()).toHaveText("817.0\n817.0\n", { timeout: 90_000 });
      await scan(page, "example with output");

      await page.goto("./#/lesson/py-values-names/3");
      await page.getByRole("button", { name: "▶ Run checks" }).click();
      await expect(page.locator(".checks li.fail").first()).toBeVisible({ timeout: 90_000 });
      await expect(page.getByRole("complementary", { name: "Professor's note" })).toBeVisible();
      await scan(page, "failed checks + tutor note");
      await expect(page.getByRole("note")).toBeVisible();
      await scan(page, "suggested-support note");
    });

    test(`every step of a lesson, a passed transfer, the Review page and the placement check have no violations (${scheme})`, async ({ page }) => {
      test.setTimeout(300_000);
      const lesson = valuesNames as unknown as Lesson;
      // Every step of a lesson that has all ten step kinds.
      const full = conditionals as unknown as Lesson;
      expect(new Set(full.steps.map((s) => s.kind)).size).toBe(10);
      for (let i = 0; i < full.steps.length; i++) {
        await page.goto(`./#/lesson/${full.id}/${i}`);
        await expect(page.locator("#step-title")).toHaveText(full.steps[i]!.title);
        await scan(page, `${full.id} step ${i} (${full.steps[i]!.kind})`);
      }
      const at = lesson.steps.findIndex((s) => s.kind === "transfer");
      await page.goto(`./#/lesson/${lesson.id}/${at}`);
      await page.locator("textarea.editor-input").fill((lesson.steps[at] as ExerciseStep).solution);
      await page.getByRole("button", { name: "▶ Run checks" }).click();
      await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
      await scan(page, "passed transfer problem");

      await page.goto("./#/review");
      await expect(page.getByText("Nothing is due for review right now.")).toBeVisible();
      await scan(page, "review page, nothing due");
      // A concept completed two days ago is due: two unaided exercises and an unaided quiz, imported as a backup.
      const t = (h: number) => new Date(Date.now() - (48 - h) * 3600_000).toISOString();
      const events = [["circle", "exercise", 0], ["practice-2", "exercise", 0.5], ["check", "quiz", 1]].map(([stepId, task, h], i) => ({
        id: `a11y-${i}`, at: t(h as number), lessonId: lesson.id, stepId, task, concept: "names", passed: true, assistance: 0, policy: "learner-heuristic-1" }));
      const backup = { format: "python-intelligence-progress", version: 2, exportedAt: t(2), lessons: [], drafts: {}, position: null, assistance: {}, events };
      await page.getByRole("button", { name: "Progress" }).click();
      await page.locator("input[type=file]").setInputFiles({ name: "h.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
      await expect(page.getByText("Progress imported.")).toBeVisible();
      await page.getByRole("button", { name: "Close" }).click();
      await expect(page.locator("form.quiz")).toBeVisible();
      await scan(page, "review page with a review due");

      await page.goto("./#/diagnostic");
      await scan(page, "placement check intro");
      await page.getByRole("button", { name: /placement check|Take it again/ }).click();
      const qs = diagnostic.checkpoints[0]!.questions;
      for (const [i, q] of qs.entries())
        await page.locator("fieldset.question").nth(i).getByRole("radio", { name: q.choices[(q.answer + 1) % q.choices.length], exact: true }).check();
      await page.getByRole("button", { name: "Check answers" }).click();
      await scan(page, "placement check, a checked group");
      await page.getByRole("button", { name: "See your starting point" }).click();
      await scan(page, "placement check result");
    });

    test(`the meso-loop step back has no violations (${scheme})`, async ({ page }) => {
      await page.goto("./#/lesson/py-values-names/3");
      for (let i = 0; i < 3; i++) {
        await page.locator("textarea.editor-input").fill('radius = "3"\narea = 3.14 * radius + 1\n');
        await page.getByRole("button", { name: "▶ Run checks" }).click();
        await expect(page.getByRole("button", { name: "▶ Run checks" })).toBeEnabled({ timeout: 90_000 });
      }
      const panel = page.locator("section.meso");
      await expect(panel).toBeVisible();
      await scan(page, "meso prediction");
      await panel.getByRole("radio").first().check();
      await panel.getByRole("button", { name: "Check my prediction" }).click();
      await expect(panel.getByRole("status")).toBeVisible();
      await scan(page, "meso explanation and transfer link");
    });
  });
}

// Interface item 12: forced colours (Windows High Contrast) and a request for more contrast, in both schemes.
for (const scheme of ["light", "dark"] as const) {
  for (const media of [{ forcedColors: "active" as const }, { contrast: "more" as const }]) {
    const name = "forcedColors" in media ? "forced colours" : "more contrast";
    test(`home, a trace and failed checks have no violations with ${name} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, ...media });
      await page.goto("./");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await scan(page, `home, ${name}`);
      await page.goto("./#/lesson/py-conditionals/2");
      await page.getByRole("button", { name: "Step ▶" }).click();
      await scan(page, `call-trace viewer, ${name}`);
      // Graded steps keep their dashed edge, so they stay distinct from the others without colour.
      const edge = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).borderTopStyle);
      expect(await edge(".stepper .dot.graded")).toBe("dashed");
      expect(await edge(".stepper .dot:not(.graded)")).toBe("solid");
      await page.goto("./#/lesson/py-values-names/3");
      await page.getByRole("button", { name: "▶ Run checks" }).click();
      await expect(page.locator(".checks li.fail").first()).toBeVisible({ timeout: 90_000 });
      await scan(page, `failed checks + tutor note, ${name}`);
    });
  }
}

test("with more contrast requested, edges use the strong border and the header is opaque", async ({ page }) => {
  await page.emulateMedia({ contrast: "more" });
  await page.goto("./");
  const look = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const top = getComputedStyle(document.querySelector(".top")!);
    return { border: css.getPropertyValue("--border").trim(), strong: css.getPropertyValue("--border-strong").trim(), blur: top.backdropFilter, bg: top.backgroundColor };
  });
  expect(look.border).toBe(look.strong); // computed custom properties substitute var(), so both read #7d879b
  expect(look.strong).toBe("#7d879b");
  expect(look.blur).toBe("none");
  expect(look.bg).toBe("rgb(255, 255, 255)");
});
