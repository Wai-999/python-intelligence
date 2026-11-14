import { expect, test, type Page } from "@playwright/test";
import first from "../content/lessons/py-values-names.json" with { type: "json" };

// The interface architecture's first items (G-20): a learning header, one primary action per screen, and a course
// map grouped by track.
const primaries = (page: Page) => page.locator(".btn.primary:visible");

test("the header names the course, lesson and standing, and offers Resume only away from the saved position", async ({ page }) => {
  await page.goto("./#/lesson/py-values-names/2");
  const now = page.locator(".top .now");
  await expect(now).toContainText("Python core");
  await expect(now).toContainText(first.title);
  await expect(now).toContainText("In progress");
  await expect(page.getByRole("link", { name: /^Resume/ })).toHaveCount(0); // we're at the saved position
  await page.goto("./#/review");
  await expect(page.getByRole("link", { name: /^Resume/ })).toHaveAttribute("href", "#/lesson/py-values-names/2");
  await expect(now).toContainText(first.title);
  await page.goto("./#/library");
  await page.getByRole("link", { name: /^Resume/ }).click();
  await expect(page).toHaveURL(/#\/lesson\/py-values-names\/2$/);
});

test("one primary action on each screen", async ({ page }) => {
  await page.goto("./#/");
  await expect(primaries(page)).toHaveCount(1); // the recommendation
  await page.goto("./#/lesson/py-values-names/0");
  await expect(primaries(page)).toHaveText(["Next →"]);
  const ex = first.steps.findIndex((s) => s.kind === "example");
  await page.goto(`./#/lesson/py-values-names/${ex}`);
  await expect(primaries(page)).toHaveText(["Next →"]); // the example's Run is secondary
  const guided = first.steps.findIndex((s) => s.kind === "guided");
  await page.goto(`./#/lesson/py-values-names/${guided}`);
  await expect(primaries(page)).toHaveText(["▶ Run checks"]);
  const quiz = first.steps.findIndex((s) => s.kind === "quiz");
  await page.goto(`./#/lesson/py-values-names/${quiz}`);
  await expect(primaries(page)).toHaveText(["Check answers"]);
  const sets = page.locator("fieldset.question");
  for (let i = 0; i < (await sets.count()); i++) await sets.nth(i).locator("input[type=radio]").last().check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(primaries(page)).toHaveText(["Try again"]);
  await page.goto(`./#/lesson/py-values-names/${first.steps.length - 1}`);
  await expect(primaries(page)).toHaveCount(1);
  await expect(primaries(page)).toHaveText(/^Finish: /);
});

test("the map is grouped by track, locked lessons fold away, and the lesson rail shows one track", async ({ page }) => {
  await page.goto("./#/");
  await expect(page.locator("section.track h2")).toHaveText([/^Python core/, /^Data/, /^Statistics/, /^Machine learning/, /^Projects/]);
  await expect(page.locator(".map-item.locked")).not.toHaveCount(0); // still in the page, folded
  expect(await page.locator(".map-item.locked:visible").count()).toBeLessThan(10);
  const homeHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(homeHeight).toBeLessThan(4000);
  await page.goto("./#/lesson/py-values-names/0");
  await expect(page.locator("aside .map section.track")).toHaveCount(1);
  await expect(page.locator("aside .map .full-map a")).toHaveAttribute("href", "#/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(first.title);
});

test("one primary action when a passed quiz is retaken and failed, and while a step back is unanswered", async ({ page }) => {
  test.setTimeout(240_000);
  const quiz = first.steps.findIndex((s) => s.kind === "quiz");
  const q = first.steps[quiz] as unknown as { questions: { answer: number }[] };
  await page.goto(`./#/lesson/py-values-names/${quiz}`);
  const sets = page.locator("fieldset.question");
  for (const [i, x] of q.questions.entries()) await sets.nth(i).locator("input[type=radio]").nth(x.answer).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(page.getByText(/Passed!/)).toBeVisible();
  await page.waitForTimeout(700); // let the result reach IndexedDB before revisiting
  await page.reload(); // revisit: credit saved, Next leads
  await expect(primaries(page)).toHaveText(["Next →"]);
  for (let i = 0; i < q.questions.length; i++) await sets.nth(i).locator("input[type=radio]").nth((q.questions[i]!.answer + 1) % 2).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(primaries(page)).toHaveText(["Next →"]);

  // Three structural errors bring the step back; until it's answered it holds the primary action.
  const guided = first.steps.findIndex((s) => s.kind === "guided");
  await page.goto(`./#/lesson/py-values-names/${guided}`);
  for (let i = 0; i < 3; i++) {
    await page.locator("textarea.editor-input").fill('radius = "3"\narea = 3.14 * radius + 1\n');
    await page.getByRole("button", { name: "▶ Run checks" }).click();
    await expect(page.getByRole("button", { name: "▶ Run checks" })).toBeEnabled({ timeout: 90_000 });
  }
  const panel = page.locator("section.meso");
  await expect(panel).toBeVisible();
  await expect(primaries(page)).toHaveCount(1);
  await expect(panel.locator(".btn.primary")).toHaveCount(1);
  await panel.getByRole("radio").first().check();
  await panel.locator(".btn.primary").click();
  await expect(panel.getByRole("status")).toBeVisible();
  await expect(primaries(page)).toHaveText(["▶ Run checks"]); // answered: the exercise leads again
});

test("a step back on an exercise passed earlier still leaves one primary action", async ({ page }) => {
  test.setTimeout(240_000);
  const guided = first.steps.findIndex((s) => s.kind === "guided");
  await page.goto(`./#/lesson/py-values-names/${guided}`);
  await page.locator("textarea.editor-input").fill((first.steps[guided] as unknown as { solution: string }).solution);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
  await expect(primaries(page)).toHaveText(["Next →"]);
  for (let i = 0; i < 3; i++) {
    await page.locator("textarea.editor-input").fill('radius = "3"\narea = 3.14 * radius + 1\n');
    await page.getByRole("button", { name: "▶ Run checks" }).click();
    await expect(page.getByRole("button", { name: "▶ Run checks" })).toBeEnabled({ timeout: 90_000 });
  }
  const panel = page.locator("section.meso");
  await expect(panel).toBeVisible();
  await expect(primaries(page)).toHaveCount(1);
  await expect(panel.locator(".btn.primary")).toHaveCount(1);
  await panel.getByRole("radio").first().check();
  await panel.locator(".btn.primary").click();
  await expect(panel.getByRole("status")).toBeVisible();
  await expect(primaries(page)).toHaveText(["Next →"]); // answered, and the step was passed: Next leads again
});

test("exercise feedback: a summary line leads, failures come first, and the note folds while a step back shows", async ({ page }) => {
  test.setTimeout(240_000);
  const guided = first.steps.findIndex((s) => s.kind === "guided");
  await page.goto(`./#/lesson/py-values-names/${guided}`);
  await expect(page.locator(".console")).toContainText("Output appears here.");
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  const summary = page.locator(".result-summary");
  await expect(summary).toHaveText(/^\d+ of \d+ checks failed\. First: /, { timeout: 120_000 });
  // pass, fail, pass in declaration order ("area exists", "area is correct", "radius unchanged"): the failure leads.
  await page.locator("textarea.editor-input").fill("radius = 3\npi = 3.14159\narea = 0\n");
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(summary).toHaveText("1 of 3 checks failed. First: area is correct", { timeout: 120_000 });
  const rows = page.locator(".checks li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveClass(/fail/);
  await expect(rows.nth(0)).toContainText("area is correct");
  await expect(rows.nth(1)).toHaveClass(/pass/);
  await expect(rows.nth(2)).toHaveClass(/pass/);
  await expect(page.getByRole("complementary", { name: "Professor's note" })).not.toHaveAttribute("data-collapsed", "");
  for (let i = 0; i < 3; i++) {
    await page.locator("textarea.editor-input").fill('radius = "3"\narea = 3.14 * radius + 1\n');
    await page.getByRole("button", { name: "▶ Run checks" }).click();
    await expect(page.getByRole("button", { name: "▶ Run checks" })).toBeEnabled({ timeout: 90_000 });
  }
  await expect(page.locator("section.meso")).toBeVisible();
  const note = page.getByRole("complementary", { name: "Professor's note" });
  await expect(note).toHaveAttribute("data-collapsed", "");
  await expect(note.locator("details")).not.toHaveAttribute("open", "");
});

test("the recap's reflection is saved in this browser and comes back after a reload", async ({ page }) => {
  const recap = first.steps.length - 1;
  await page.goto(`./#/lesson/py-values-names/${recap}`);
  const box = page.getByLabel("In one sentence: what does this lesson let you do now?");
  await box.fill("Name values and build new ones from them.");
  await page.waitForTimeout(700); // let it reach IndexedDB
  await page.reload();
  await expect(page.getByLabel("In one sentence: what does this lesson let you do now?")).toHaveValue("Name values and build new ones from them.");
});

test("the exercise's result status is one region, exposed before, during and after a run", async ({ page }) => {
  test.setTimeout(240_000);
  const guided = first.steps.findIndex((s) => s.kind === "guided");
  await page.goto(`./#/lesson/py-values-names/${guided}`);
  const region = page.locator(".cell.exercise p.result-summary[role=status]");
  await expect(region).toHaveCount(1);
  await expect(region).toHaveText("");
  const exposed = () => region.evaluate((el) => getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden" && !el.closest("[aria-hidden=true]"));
  expect(await exposed()).toBe(true);
  await region.evaluate((el) => { (window as unknown as { __region: Element }).__region = el; });
  const same = () => region.evaluate((el) => el === (window as unknown as { __region: Element }).__region);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  expect(await exposed()).toBe(true); // during the run (it may still be empty)
  await expect(region).toHaveText(/checks failed/, { timeout: 120_000 });
  expect(await same()).toBe(true);
  await page.locator("textarea.editor-input").fill((first.steps[guided] as unknown as { solution: string }).solution);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(region).toHaveText(/All checks pass/, { timeout: 120_000 });
  expect(await same()).toBe(true);
  expect(await exposed()).toBe(true);
});
