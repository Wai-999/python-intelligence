import { expect, test, type Page } from "@playwright/test";
import { MAX_OUTPUT_CHARS } from "../src/py/protocol";

// Resource limits (master prompt §9 and test matrix T04/T05): output is capped, runaway code is stopped, a failed
// allocation is an ordinary Python error, and the page stays usable afterwards.
const editor = (page: Page) => page.locator("textarea.editor-input").first();
const run = async (page: Page, code: string) => {
  await editor(page).fill(code);
  await page.getByRole("button", { name: "▶ Run" }).click();
};
const recovers = async (page: Page) => {
  await run(page, "print('back')\n");
  await expect(page.locator(".console pre").first()).toHaveText("back\n", { timeout: 90_000 });
};

test("a huge print is cut off at the output limit, and Python keeps working", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("./#/lesson/py-functions/4");
  await run(page, "for i in range(300_000):\n    print(i)\n");
  const out = page.locator(".console pre").first();
  await expect(out).toContainText("output truncated", { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "▶ Run" })).toBeEnabled({ timeout: 60_000 });
  const text = await out.innerText();
  expect(text.length).toBeLessThan(MAX_OUTPUT_CHARS + 200);
  expect(text.startsWith("0\n1\n2\n")).toBe(true);
  await recovers(page);
});

test("an endless print loop is stopped by the time limit with its output capped", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("./#/lesson/py-functions/4");
  await run(page, "while True:\n    print('spam')\n");
  await expect(page.locator(".console-error")).toContainText("TimeoutError", { timeout: 120_000 });
  const text = await page.locator(".console pre").first().innerText();
  expect(text).toContain("output truncated");
  expect(text.length).toBeLessThan(MAX_OUTPUT_CHARS + 200);
  await recovers(page);
});

test("a huge allocation fails as a MemoryError, and Python keeps working", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("./#/lesson/py-functions/4");
  await run(page, "data = [0] * 10 ** 9\n");
  await expect(page.locator(".console-error")).toContainText("MemoryError", { timeout: 120_000 });
  await recovers(page);
});
