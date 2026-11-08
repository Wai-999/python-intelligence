import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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

      await page.goto("./#/lesson/py-conditionals/1");
      await expect(page.getByRole("heading", { name: "A comparison is a question" })).toBeVisible();
      await scan(page, "intuition step with sources and look-ahead notice");

      await page.goto("./#/lesson/py-conditionals/2");
      await page.getByRole("button", { name: "Step ▶" }).click();
      await scan(page, "call-trace viewer");

      await page.goto("./#/lesson/py-conditionals/7");
      await expect(page.locator("fieldset.question").first()).toBeVisible();
      await scan(page, "quiz");

      await page.goto("./#/lesson/py-conditionals/8");
      await expect(page.getByRole("region", { name: "Further reading" })).toBeVisible();
      await scan(page, "recap with further reading");

      await page.getByRole("button", { name: "Progress" }).click();
      await scan(page, "progress panel");
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
    });
  });
}
