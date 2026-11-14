import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import diagnostic from "../content/diagnostic.json" with { type: "json" };
import lists from "../content/lessons/py-lists.json" with { type: "json" };
import first from "../content/lessons/py-values-names.json" with { type: "json" };

// The placement check (G-12): testing out unlocks later lessons and moves the recommendation, but completes nothing.
type Q = { id: string; choices: string[]; answer: number };
const cps = diagnostic.checkpoints as { id: string; covers: string[]; questions: Q[] }[];

async function answerGroup(page: Page, qs: Q[], wrongFirst = false) {
  for (const [i, q] of qs.entries()) {
    const pick = wrongFirst && i === 0 ? (q.answer + 1) % q.choices.length : q.answer;
    await page.locator("fieldset.question").nth(i).getByRole("radio", { name: q.choices[pick], exact: true }).check();
  }
  await page.getByRole("button", { name: "Check answers" }).click();
}

test("passing two groups tests out of their lessons and starts at the next, without completing anything", async ({ page }) => {
  await page.goto("./#/");
  await page.getByRole("link", { name: "Take the placement check" }).click();
  await page.getByRole("button", { name: "Start the placement check" }).click();
  await answerGroup(page, cps[0]!.questions);
  await page.getByRole("button", { name: "Next group →" }).click();
  await answerGroup(page, cps[1]!.questions);
  await page.getByRole("button", { name: "Next group →" }).click();
  await answerGroup(page, cps[2]!.questions, true);
  await expect(page.getByRole("status")).toContainText("this is where you start");
  await page.getByRole("button", { name: "See your starting point" }).click();
  const tested = [...cps[0]!.covers, ...cps[1]!.covers];
  await expect(page.getByRole("status")).toContainText(`You tested out of ${tested.length} lessons`);
  await expect(page.getByRole("button", { name: `Start: ${lists.title} →` })).toBeVisible();

  // The map: tested-out lessons say so and link; the next lesson is unlocked and recommended; nothing is completed.
  await page.goto("./#/");
  await expect(page.locator(".map-item.tested")).toHaveCount(tested.length);
  await expect(page.locator(".map-item.done")).toHaveCount(0);
  await expect(page.getByLabel(/^0 of \d+ lessons completed$/)).toBeVisible();
  await expect(page.locator(".recommend")).toContainText(`Next lesson: ${lists.title}`);
  await expect(page.locator(".map-item.tested .map-link").first()).toHaveAttribute("href", /#\/lesson\//);

  // It survives a reload (stored in the event log in this browser).
  await page.reload();
  await expect(page.locator(".map-item.tested")).toHaveCount(tested.length);
  await expect(page.getByText(`you tested out of ${tested.length} lessons`)).toBeVisible();

  // Retaking and stopping at once replaces the placement: back to the beginning.
  await page.getByRole("link", { name: "Retake it" }).click();
  await page.getByRole("button", { name: "Take it again" }).click();
  await page.getByRole("button", { name: "Stop here and start at this group" }).click();
  await expect(page.getByRole("status")).toContainText("nothing was skipped");
  await page.goto("./#/");
  await expect(page.locator(".map-item.tested")).toHaveCount(0);
  await expect(page.locator(".recommend")).toContainText(first.title);
});

test("stopping before checking a fully answered group doesn't count it as passed", async ({ page }) => {
  await page.goto("./#/diagnostic");
  await page.getByRole("button", { name: "Start the placement check" }).click();
  for (const [i, q] of cps[0]!.questions.entries())
    await page.locator("fieldset.question").nth(i).getByRole("radio", { name: q.choices[q.answer], exact: true }).check();
  await page.getByRole("button", { name: "Stop here and start at this group" }).click();
  await expect(page.getByRole("status")).toContainText("nothing was skipped");
});

test("the placement check has no WCAG A/AA violations", async ({ page }) => {
  const scan = async (label: string) => {
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.help}`), label).toEqual([]);
  };
  await page.goto("./#/diagnostic");
  await scan("intro");
  await page.getByRole("button", { name: "Start the placement check" }).click();
  await answerGroup(page, cps[0]!.questions, true);
  await scan("checked group");
  await page.getByRole("button", { name: "See your starting point" }).click();
  await scan("result");
});
