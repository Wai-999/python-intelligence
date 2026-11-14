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

test("a completion saved before the lesson gained its transfer problem doesn't stand after an import", async ({ page }) => {
  const graded = first.steps.filter((s) => ["guided", "challenge", "quiz"].includes(s.kind));
  const at = "2026-11-01T10:00:00.000Z";
  const backup = { format: "python-intelligence-progress", version: 2, exportedAt: at, drafts: {}, position: null, assistance: {}, events: [],
    lessons: [{ lessonId: first.id, furthestStep: 5, completed: true, completedAt: at, mastery: 1, struggles: {},
      steps: Object.fromEntries(graded.map((s) => [s.id, { passed: true, attempts: 1, updatedAt: at, ...(s.kind === "quiz" ? { score: 1 } : {}) }])) }] };
  await page.goto("./#/");
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "old.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".map-item.done")).toHaveCount(0);
  await expect(page.getByLabel(/^0 of \d+ lessons completed$/)).toBeVisible();
  await expect(page.locator(".map-item").first()).toContainText("In progress");
  await page.reload(); // re-read from IndexedDB: still not complete
  await expect(page.locator(".map-item.done")).toHaveCount(0);
});
