import { expect, test, type Page } from "@playwright/test";
import lists from "../content/lessons/py-lists.json" with { type: "json" };

// "Try another example" (master prompt §5): an example step cycles through further worked examples of the same idea,
// moves focus to each new one's heading, shows its own setup and code, and runs the code it shows.
type More = { title: string; body: string; code: string; expected_output: string };
const plain = (md: string) => md.replace(/[`*]/g, "");

async function runAndCheck(page: Page, expected: string) {
  await page.getByRole("button", { name: "▶ Run" }).click();
  await expect(page.getByRole("log", { name: "Program output" })).toHaveText(expected.trimEnd(), { timeout: 120_000 });
}

test("Try another example cycles every further example, focuses its heading, shows its code and runs it", async ({ page }) => {
  test.setTimeout(240_000);
  const at = lists.steps.findIndex((s) => s.kind === "example");
  const step = lists.steps[at] as (typeof lists.steps)[number] & { code: string; expected_output: string; more: More[] };
  expect(step.more.length).toBeGreaterThan(0);
  const total = step.more.length + 1;
  const code = page.getByLabel("Example code");
  await page.goto(`./#/lesson/py-lists/${at}`);
  await expect(page.locator(".another-bar")).toContainText(`example 1 of ${total}`);
  await expect(page.locator(".examples .another")).toHaveCount(0);
  await expect(code).toHaveValue(step.code);

  for (const [k, m] of step.more.entries()) {
    await page.getByRole("button", { name: "Try another example" }).click();
    await expect(page.getByRole("heading", { level: 3, name: `Another example: ${m.title}` })).toBeFocused();
    await expect(page.locator(".examples .another")).toContainText(plain(m.body));
    await expect(page.locator(".another-bar")).toContainText(`example ${k + 2} of ${total}`);
    await expect(code).toHaveValue(m.code);
    await expect(page.getByRole("log", { name: "Program output" })).toContainText("Output appears here."); // fresh cell
    await runAndCheck(page, m.expected_output);
  }

  await page.getByRole("button", { name: "Back to the first example" }).click();
  await expect(page.locator(".examples .another")).toHaveCount(0);
  await expect(page.locator(".another-bar")).toContainText(`example 1 of ${total}`);
  await expect(code).toHaveValue(step.code);
  await runAndCheck(page, step.expected_output);
});
