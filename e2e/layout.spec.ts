import { expect, test, type Page } from "@playwright/test";

// Interface items 10 and 15: layout guardrails on a phone (the "mobile" project) and on desktop, so the page stays
// compact as content grows. Heights and widths are measured, not eyeballed.
const measure = (page: Page) => page.evaluate(() => ({
  header: Math.round(document.querySelector("header.top")!.getBoundingClientRect().height),
  scrollWidth: document.documentElement.scrollWidth,
  width: document.documentElement.clientWidth,
  height: document.documentElement.scrollHeight,
}));
const PAGES = ["./#/", "./#/lesson/py-conditionals/1", "./#/lesson/py-conditionals/3", "./#/lesson/py-conditionals/5", "./#/review", "./#/library", "./#/diagnostic"];

test("the header stays short and nothing scrolls sideways", async ({ page }, info) => {
  const phone = info.project.name === "mobile";
  for (const url of PAGES) {
    await page.goto(url);
    await expect(page.locator("main, .layout").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    const m = await measure(page);
    expect(m.scrollWidth, `${url}: horizontal scroll`).toBeLessThanOrEqual(m.width);
    expect(m.header, `${url}: header height`).toBeLessThanOrEqual(phone ? 96 : 72);
  }
});

test("pages stay short: the home map on desktop, a prose step on a phone", async ({ page }, info) => {
  if (info.project.name === "mobile") {
    await page.goto("./#/lesson/py-conditionals/1");
    await expect(page.locator("#step-title")).toBeFocused();
    expect((await measure(page)).height).toBeLessThan(3000);
  } else {
    await page.goto("./#/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect((await measure(page)).height).toBeLessThan(2600);
  }
});
