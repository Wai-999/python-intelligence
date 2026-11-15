import { expect, test, type Page } from "@playwright/test";
import first from "../content/lessons/py-values-names.json" with { type: "json" };
import arrays from "../content/lessons/np-arrays.json" with { type: "json" };

// Interface items 10 and 15: layout guardrails on a phone (the "mobile" project) and on desktop, so the page stays
// compact as content grows. Heights and widths are measured, not eyeballed.
const measure = (page: Page) => page.evaluate(() => ({
  header: Math.round(document.querySelector("header.top")!.getBoundingClientRect().height),
  scrollWidth: document.documentElement.scrollWidth,
  width: document.documentElement.clientWidth,
  height: document.documentElement.scrollHeight,
}));
/** On a phone, Resume, Library, the course total and Progress sit behind the header's Menu button. */
const openMenu = async (page: Page) => {
  const menu = page.getByRole("button", { name: "Menu" });
  if (await menu.isVisible() && (await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
};
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

test("offline, with a saved position, the header still fits the screen", async ({ page, context }, info) => {
  await page.goto("./#/lesson/py-conditionals/1"); // saves a position, so Resume shows elsewhere
  await expect(page.locator("#step-title")).toBeFocused();
  await page.evaluate(() => { location.hash = "#/review"; });
  await context.setOffline(true);
  await expect(page.locator(".conn.offline")).toContainText("Offline");
  const m = await measure(page);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.width);
  expect(m.header).toBeLessThanOrEqual(info.project.name === "mobile" ? 96 : 72);
  await openMenu(page); // the open menu may add a row, but never pushes anything off screen
  await expect(page.getByRole("link", { name: /^Resume/ })).toBeVisible();
  for (const sel of [".conn.offline", ".resume", ".top-right .btn:last-child"]) {
    const box = (await page.locator(sel).boundingBox())!;
    expect(box.x + box.width, `${sel} inside the screen`).toBeLessThanOrEqual(m.width);
  }
  await context.setOffline(false);
});

test("the course total the phone header drops is in the progress panel", async ({ page }) => {
  // Two completed lessons in different tracks, every graded step passed, imported like any backup.
  const graded = new Set(["guided", "challenge", "transfer", "quiz"]);
  const at = "2026-11-01T10:00:00.000Z";
  const done = (l: { id: string; steps: { id: string; kind: string }[] }) => ({ lessonId: l.id, completed: true, completedAt: at, mastery: 1, struggles: {},
    furthestStep: l.steps.length - 1,
    steps: Object.fromEntries(l.steps.filter((s) => graded.has(s.kind)).map((s) => [s.id, { passed: true, attempts: 1, updatedAt: at, ...(s.kind === "quiz" ? { score: 1 } : {}) }])) });
  const backup = { format: "python-intelligence-progress", version: 2, exportedAt: at, drafts: {}, position: null, assistance: {}, events: [],
    lessons: [done(first), done(arrays)] };
  await page.goto("./#/");
  await openMenu(page);
  await page.getByRole("button", { name: "Progress" }).click();
  await expect(page.locator(".course-total")).toHaveText("Lessons completed: 0 of 44");
  await page.locator("input[type=file]").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await expect(page.locator(".course-total")).toHaveText("Lessons completed: 2 of 44");
});

test.describe("a 320 px phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test("with a saved position, a review badge and offline, the header fits in 96 px; Menu holds Resume and the rest", async ({ page, context }) => {
    test.skip(test.info().project.name !== "mobile", "phone only");
    await page.clock.install({ time: new Date("2026-03-02T09:00:00Z") });
    // A completed concept whose first review falls due a day later gives the Review badge.
    const at = (h: number) => new Date(Date.parse("2026-03-01T09:00:00Z") + h * 3600_000).toISOString();
    const backup = { format: "python-intelligence-progress", version: 2, exportedAt: at(0), lessons: [], drafts: {}, position: null, assistance: {},
      events: [["circle", "exercise"], ["practice-2", "exercise"], ["check", "quiz"]].map(([stepId, task], i) => ({ id: `s${i}`, at: at(i * 0.5),
        lessonId: "py-values-names", stepId, task, concept: "names", passed: true, assistance: 0, policy: "learner-heuristic-1" })) };
    await page.goto("./#/lesson/py-conditionals/1"); // a saved position: Resume shows elsewhere
    await expect(page.locator("#step-title")).toBeFocused();
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("button", { name: "Progress" }).click();
    await page.locator("input[type=file]").setInputFiles({ name: "b.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
    await expect(page.getByText("Progress imported.")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await page.clock.setSystemTime(new Date("2026-03-03T10:00:00Z"));
    await page.evaluate(() => { location.hash = "#/library"; });
    await expect(page.locator(".top .badge")).toBeVisible();
    await context.setOffline(true);
    await expect(page.locator(".conn.offline")).toContainText("Offline");
    const m = await measure(page);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.width);
    expect(m.header).toBeLessThanOrEqual(96);
    await expect(page.locator(".conn.offline")).toContainText("lessons work"); // the full sentence, for screen readers
    // Menu reveals Library, the course total and Progress; Escape folds them back and returns focus.
    await expect(page.locator("header.top").getByRole("link", { name: "Library", exact: true })).toBeHidden();
    const toggle = page.getByRole("button", { name: "Menu" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("header.top").getByRole("link", { name: "Library", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Resume/ })).toHaveAttribute("href", "#/lesson/py-conditionals/1");
    await expect(page.getByRole("button", { name: "Progress" })).toBeVisible();
    expect((await measure(page)).scrollWidth).toBeLessThanOrEqual(320); // the open menu wraps, never scrolls sideways
    await page.locator("header.top").getByRole("link", { name: "Library", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    await expect(page.locator("header.top").getByRole("link", { name: "Library", exact: true })).toBeHidden();
    await context.setOffline(false);
  });
});
