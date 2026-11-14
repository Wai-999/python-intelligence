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
