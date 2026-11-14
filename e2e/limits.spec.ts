import { expect, test, type Page } from "@playwright/test";
import { MAX_OUTPUT_CHARS, OUTPUT_TRUNCATED } from "../src/py/protocol";

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

// The console shows stdout, then stderr. Lines of 99 characters plus a newline make the budget arithmetic exact.
const shown = async (page: Page) => {
  const out = page.locator(".console pre").first();
  await expect(page.getByRole("button", { name: "▶ Run" })).toBeEnabled({ timeout: 120_000 });
  return (await out.textContent()) ?? "";
};
const line = (ch: string) => ch.repeat(99) + "\n";
const notes = (text: string) => text.split(OUTPUT_TRUNCATED).length - 1;

test("stdout and stderr share one budget: an exact fit keeps everything, one more line gets only the note", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("./#/lesson/py-functions/4");
  const both = "import sys\nfor i in range(600):\n    print('o' * 99)\nfor i in range(400):\n    print('e' * 99, file=sys.stderr)\n";
  await run(page, both);
  const exact = await shown(page);
  expect(exact).toBe(line("o").repeat(600) + line("e").repeat(400)); // 100,000 characters, nothing cut, no note
  expect(exact.length).toBe(MAX_OUTPUT_CHARS);
  await run(page, both + "print('x' * 50)\nprint('late', file=sys.stderr)\n");
  const over = await shown(page);
  expect(over).toBe(line("o").repeat(600) + line("e").repeat(400) + OUTPUT_TRUNCATED + "\n");
  expect(notes(over)).toBe(1);
  await recovers(page); // a fresh budget: the next run shows its output and no note
});

test("the line that crosses the limit is cut to the room left, followed by exactly one note", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("./#/lesson/py-functions/4");
  await run(page, "for i in range(999):\n    print('o' * 99)\nprint('y' * 200)\nfor i in range(5):\n    print('after')\n");
  const text = await shown(page);
  // 99,900 characters kept, then 99 of the 200 y's plus a newline: exactly 100,000, then the note.
  expect(text).toBe(line("o").repeat(999) + "y".repeat(99) + "\n" + OUTPUT_TRUNCATED + "\n");
  expect(text).not.toContain("after");
  expect(notes(text)).toBe(1);
});

test("stderr alone is capped the same way", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("./#/lesson/py-functions/4");
  await run(page, "import sys\nfor i in range(1500):\n    print('e' * 99, file=sys.stderr)\n");
  const text = await shown(page);
  expect(text).toBe(line("e").repeat(1000) + OUTPUT_TRUNCATED + "\n");
  expect(notes(text)).toBe(1);
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
