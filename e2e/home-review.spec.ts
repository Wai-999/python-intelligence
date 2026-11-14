import { expect, test } from "@playwright/test";
import first from "../content/lessons/py-values-names.json" with { type: "json" };
import lists from "../content/lessons/py-lists.json" with { type: "json" };

// The interface architecture's third batch: a first visit leads with the placement check (item 13), code steps link to
// the lesson's execution trace (item 9, first part), the Review page offers a way on when nothing is due (item 11), and
// the progress panel says when something was last saved (item 14).
const primaries = (page: import("@playwright/test").Page) => page.locator(".btn.primary:visible");

test("a first visit leads with finding a starting point; a returning learner's home leads with the recommendation", async ({ page }) => {
  await page.goto("./#/");
  await expect(primaries(page)).toHaveText(["Find your starting point"]);
  await expect(primaries(page)).toHaveAttribute("href", "#/diagnostic");
  await expect(page.getByRole("link", { name: "Take the placement check" })).toBeVisible();
  await expect(page.locator(".recommend").getByRole("button")).toHaveText(`Next lesson: ${first.title} →`);

  await page.goto("./#/lesson/py-values-names/1"); // saves a reading position
  await expect(page.locator("#step-title")).toBeFocused();
  await page.goto("./#/");
  await expect(page.getByRole("link", { name: "Find your starting point" })).toHaveCount(0);
  await expect(primaries(page)).toHaveCount(1);
  await expect(primaries(page)).toHaveText(`Continue: ${first.title} →`);
});

test("example and exercise steps link to the lesson's execution trace; a lesson without one has no link", async ({ page }) => {
  const visual = lists.steps.findIndex((s) => s.kind === "visual");
  const example = lists.steps.findIndex((s) => s.kind === "example");
  const guided = lists.steps.findIndex((s) => s.kind === "guided");
  for (const at of [example, guided]) {
    await page.goto(`./#/lesson/py-lists/${at}`);
    await expect(page.getByRole("link", { name: "Show execution trace →" })).toHaveAttribute("href", `#/lesson/py-lists/${visual}`);
  }
  await page.goto("./#/lesson/py-lists/0"); // a prose step
  await expect(page.locator("#step-title")).toBeFocused();
  await expect(page.getByRole("link", { name: "Show execution trace →" })).toHaveCount(0);
  await page.goto(`./#/lesson/py-values-names/${first.steps.findIndex((s) => s.kind === "example")}`);
  await expect(page.locator("#step-title")).toBeFocused();
  await expect(page.getByRole("link", { name: "Show execution trace →" })).toHaveCount(0);
});

test("with nothing due, Review offers one way on: back to where the learner left off", async ({ page }) => {
  await page.goto("./#/review");
  await expect(page.getByText("Nothing is due for review right now.")).toBeVisible();
  await expect(primaries(page)).toHaveCount(0); // nowhere to go back to yet
  await page.goto("./#/lesson/py-values-names/2");
  await expect(page.locator("#step-title")).toBeFocused();
  await page.goto("./#/review");
  await expect(primaries(page)).toHaveText([`Continue: ${first.title} →`]);
  await expect(primaries(page)).toHaveAttribute("href", "#/lesson/py-values-names/2");
});

test("the progress panel says when anything was last saved", async ({ page }) => {
  await page.goto("./#/");
  await page.getByRole("button", { name: "Progress" }).click();
  await expect(page.locator(".saved-at")).toHaveText("Nothing saved yet.");
  await page.getByRole("button", { name: "Close" }).click();
  await page.goto("./#/lesson/py-values-names/1");
  await expect(page.locator("#step-title")).toBeFocused();
  await page.getByRole("button", { name: "Progress" }).click();
  await expect(page.locator(".saved-at")).toContainText("Last saved:");
  await expect(page.locator(".saved-at time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/);
});
