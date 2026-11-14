import { expect, test, type Page } from "@playwright/test";
import functions from "../content/lessons/py-functions.json" with { type: "json" };
import first from "../content/lessons/py-values-names.json" with { type: "json" };

// §1.4 "Why this lesson" and §10 map states: completed independently vs with help (G-16).
const editor = (page: Page) => page.locator("textarea.editor-input");
const checks = async (page: Page, code: string) => {
  await editor(page).fill(code);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
};

async function completeLessonOne(page: Page, hintFirst: boolean) {
  await page.goto("./#/lesson/py-values-names/3");
  if (hintFirst) await page.getByRole("button", { name: /^Show a hint/ }).click();
  await checks(page, "radius = 3\npi = 3.14159\narea = pi * radius ** 2\n");
  await page.goto("./#/lesson/py-values-names/4");
  await checks(page, "price = 2.5\ncount = 4\nsubtotal = price * count\ntax = subtotal * 0.2\ntotal = subtotal + tax\nprint(total)\n");
  await page.goto("./#/lesson/py-values-names/5");
  const sets = page.locator("fieldset.question");
  for (const [i, a] of [0, 1, 1].entries()) await sets.nth(i).locator("input[type=radio]").nth(a).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(page.getByText(/Passed!/)).toBeVisible();
  await page.goto("./#/");
}

test("every lesson step says why this lesson: what it builds on and what it opens", async ({ page }) => {
  await page.goto("./#/lesson/py-functions/2");
  const why = page.locator(".lesson-head .why");
  await expect(why).toContainText(`Why this lesson: it builds on ${first.title}`);
  await expect(why).toContainText("and it opens");
  await expect(why.getByRole("link", { name: first.title })).toHaveAttribute("href", "#/lesson/py-values-names/0");
  await page.goto("./#/lesson/py-values-names/0");
  await expect(page.locator(".lesson-head .why")).toContainText("it's where the course starts");
  await expect(page.locator(".lesson-head .why")).toContainText(functions.title);
});

test("a lesson completed without help says so on the map", async ({ page }) => {
  test.setTimeout(300_000);
  await completeLessonOne(page, false);
  await expect(page.locator(".map-item.done")).toHaveCount(1);
  await expect(page.locator(".map-item.done .map-meta")).toContainText("Completed independently");
});

test("a lesson completed with a hint says it was completed with help", async ({ page }) => {
  test.setTimeout(300_000);
  await completeLessonOne(page, true);
  await expect(page.locator(".map-item.done .map-meta")).toContainText("Completed with help");
  await expect(page.locator(".map-item.done .map-meta")).not.toContainText("independently");
});
