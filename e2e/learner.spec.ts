import { expect, test, type Page } from "@playwright/test";

// The architecture's core acceptance test: a learner completes a lesson, executes Python, saves,
// refreshes, resumes at the exact point, and gets a valid next recommendation.

const editor = (page: Page) => page.locator("textarea.editor-input");

async function setCode(page: Page, code: string) {
  await editor(page).fill(code);
}

async function passQuiz(page: Page, answers: number[]) {
  const sets = page.locator("fieldset.question");
  for (let i = 0; i < answers.length; i++) await sets.nth(i).locator("input[type=radio]").nth(answers[i]!).check();
  await page.getByRole("button", { name: "Check answers" }).click();
  await expect(page.getByText(/Passed!/)).toBeVisible();
}

test("complete lesson 1, refresh mid-lesson 2, resume exactly, get next recommendation", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Learn Python by running it." })).toBeVisible();
  // Locked prerequisites are enforced in the map.
  await expect(page.locator(".map-item.locked")).toHaveCount(2);
  await page.getByRole("button", { name: /Next lesson: Values, names and expressions/ }).click();

  // Run the example (real Pyodide in a worker).
  await page.goto("./#/lesson/py-values-names/2");
  await page.getByRole("button", { name: "▶ Run" }).click();
  await expect(page.locator(".console pre").first()).toHaveText("817.0\n817.0\n", { timeout: 90_000 });

  // Guided exercise: fail first (tutor feedback shows), then pass.
  await page.goto("./#/lesson/py-values-names/3");
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.locator(".checks li.fail").first()).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Professor's note" })).toBeVisible();
  await setCode(page, "radius = 3\npi = 3.14159\narea = pi * radius ** 2\n");
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible();

  await page.goto("./#/lesson/py-values-names/4");
  await passQuiz(page, [0, 1, 1]);
  await page.goto("./#/lesson/py-values-names/5");
  await expect(page.getByText(/Lesson complete/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Next lesson: Functions: naming a computation/ })).toBeVisible();

  // Lesson 2: write an in-progress draft at the guided step, then refresh with NO hash.
  await page.goto("./#/lesson/py-functions/5");
  await expect(page.getByRole("heading", { name: "Guided practice: convert temperatures" })).toBeVisible();
  await setCode(page, "def celsius_to_fahrenheit(c):\n    return c * 9 / 5  # unfinished\n");
  await page.waitForTimeout(700); // draft autosave debounce
  await page.goto("./"); // a learner returning later, landing on the home URL
  await page.reload();

  await expect(page).toHaveURL(/#\/lesson\/py-functions\/5$/);
  await expect(page.getByRole("heading", { name: "Guided practice: convert temperatures" })).toBeVisible();
  await expect(editor(page)).toHaveValue(/# unfinished/);
  await expect(page.locator(".map-item.done")).toHaveCount(1);
});

test("an infinite loop is stopped and Python recovers", async ({ page }) => {
  await page.goto("./#/lesson/py-functions/4");
  await setCode(page, "while True:\n    pass\n");
  await page.getByRole("button", { name: "▶ Run" }).click();
  await expect(page.locator(".console-error")).toContainText("TimeoutError", { timeout: 120_000 });
  await expect(page.getByText(/infinite loop/)).toBeVisible();
  await setCode(page, "print('back')\n");
  await page.getByRole("button", { name: "▶ Run" }).click();
  await expect(page.locator(".console pre").first()).toHaveText("back\n", { timeout: 90_000 });
});

test("export, reset, and import restore progress", async ({ page }) => {
  await page.goto("./#/lesson/py-values-names/4");
  await passQuiz(page, [0, 1, 1]);
  await page.getByRole("button", { name: "Progress" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export progress" }).click()]);
  const path = await download.path();
  await page.getByRole("button", { name: "Reset…" }).click();
  await page.getByRole("button", { name: "Erase everything" }).click();
  await expect(page.getByText("Progress reset.")).toBeVisible();
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.goto("./#/lesson/py-values-names/4");
  await expect(page.getByText(/Passed earlier/)).toBeVisible();
});

test("a corrupt import is rejected and leaves progress unchanged", async ({ page }) => {
  await page.goto("./#/lesson/py-values-names/4");
  await passQuiz(page, [0, 1, 1]);
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"format":"nope"}') });
  await expect(page.getByText(/Import failed, and your current progress was left unchanged/)).toBeVisible();
  await page.goto("./#/lesson/py-values-names/4");
  await expect(page.getByText(/Passed earlier/)).toBeVisible();
});
