import { expect, test } from "@playwright/test";

// Runs on desktop AND a mobile viewport: base path, no horizontal overflow, keyboard skip link, trace stepper.
test("loads under the sub-path, fits the viewport, and is keyboard reachable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  await page.goto("./#/lesson/py-functions/2");
  await page.getByRole("button", { name: "Step ▶" }).click();
  await page.getByRole("button", { name: "Step ▶" }).click();
  await expect(page.locator(".trace-note")).toContainText("Step 3 of 6");
  await expect(page.locator(".locals")).toContainText("width");
  expect(errors).toEqual([]);
});
