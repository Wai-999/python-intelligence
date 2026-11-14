import { expect, test } from "@playwright/test";
import lists from "../content/lessons/py-lists.json" with { type: "json" };

// "Try another example" (master prompt §5): an example step cycles through further worked examples of the same idea,
// moves focus to each new one's heading, and runs the shown code.
test("Try another example cycles the further examples, focuses each heading and runs its code", async ({ page }) => {
  test.setTimeout(180_000);
  const at = lists.steps.findIndex((s) => s.kind === "example");
  const step = lists.steps[at] as (typeof lists.steps)[number] & { more: { title: string; code: string; expected_output: string }[] };
  expect(step.more.length).toBeGreaterThan(0);
  const total = step.more.length + 1;
  await page.goto(`./#/lesson/py-lists/${at}`);
  const another = page.getByRole("button", { name: "Try another example" });
  await expect(page.locator(".another-bar")).toContainText(`example 1 of ${total}`);
  await expect(page.locator(".examples .another")).toHaveCount(0);

  await another.click();
  const heading = page.getByRole("heading", { level: 3, name: `Another example: ${step.more[0]!.title}` });
  await expect(heading).toBeFocused();
  await expect(page.locator(".another-bar")).toContainText(`example 2 of ${total}`);
  await page.getByRole("button", { name: "▶ Run" }).click();
  await expect(page.getByRole("log", { name: "Program output" })).toHaveText(step.more[0]!.expected_output.trimEnd(), { timeout: 120_000 });

  for (let k = 1; k < step.more.length; k++) await another.click();
  await expect(page.getByRole("heading", { level: 3, name: `Another example: ${step.more.at(-1)!.title}` })).toBeFocused();
  await page.getByRole("button", { name: "Back to the first example" }).click();
  await expect(page.locator(".examples .another")).toHaveCount(0);
  await expect(page.locator(".another-bar")).toContainText(`example 1 of ${total}`);
  await expect(page.getByRole("log", { name: "Program output" })).toContainText("Output appears here.");
});
