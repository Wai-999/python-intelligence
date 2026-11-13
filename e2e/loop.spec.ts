import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Lesson } from "../src/content/types";
import valuesNames from "../content/lessons/py-values-names.json" with { type: "json" };

const lesson = valuesNames as unknown as Lesson;
const at = lesson.steps.findIndex((s) => s.id === "circle");

async function exportEvents(page: Page) {
  await page.getByRole("button", { name: "Progress" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export progress" }).click();
  const data = JSON.parse(readFileSync(await (await download).path(), "utf8")) as { events: { task: string; tags?: string[]; supports?: string[]; id: string }[] };
  await page.getByRole("button", { name: "Close" }).click();
  return data.events;
}
async function runCode(page: Page, code: string) {
  await page.locator("textarea.editor-input").fill(code);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByRole("button", { name: "▶ Run checks" })).toBeEnabled({ timeout: 120_000 });
}

test("a repeated typo never triggers a step back, but a repeated structural error does, once", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`./#/lesson/py-values-names/${at}`);
  for (let i = 0; i < 4; i++) await runCode(page, "radius = 3\nif radius > 2\n    print(radius)\n"); // a missing colon, four times
  await expect(page.getByRole("heading", { name: "Let's step back for a moment" })).toHaveCount(0);

  for (let i = 0; i < 3; i++) await runCode(page, 'radius = "3"\narea = 3.14 * radius + 1\n'); // the same TypeError, three times
  const panel = page.locator("section.meso");
  await expect(panel.getByRole("heading", { name: "Let's step back for a moment" })).toBeFocused();
  await expect(panel).toContainText("TypeError");
  await panel.getByRole("radio", { name: "It stops with a TypeError" }).check();
  await panel.getByRole("button", { name: "Check my prediction" }).click();
  await expect(panel.getByRole("status")).toContainText("Right.");

  const events = await exportEvents(page);
  const decisions = events.filter((e) => e.task === "intervention");
  expect(decisions.map((d) => d.tags!.find((t) => t.startsWith("outcome:")))).toEqual(["outcome:shown", "outcome:answered"]);
  expect(decisions[0]!.tags).toContain("signature:error:TypeError");
  const ids = new Set(events.map((e) => e.id));
  expect(decisions[0]!.supports!.length).toBeGreaterThanOrEqual(3);
  expect(decisions[0]!.supports!.every((id) => ids.has(id))).toBe(true);

  // Cooldown: three more of the same error right away don't bring it back.
  await page.goto("./#/");
  await page.goto(`./#/lesson/py-values-names/${at}`);
  for (let i = 0; i < 3; i++) await runCode(page, 'radius = "3"\narea = 3.14 * radius + 1\n');
  await expect(page.locator("section.meso")).toHaveCount(0);
});

test("the learner can postpone a step back", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`./#/lesson/py-values-names/${at}`);
  for (let i = 0; i < 3; i++) await runCode(page, "items = []\nprint(sum(items) / len(items))\n");
  const panel = page.locator("section.meso");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Not now" }).click();
  await expect(panel).toHaveCount(0);
  const outcomes = (await exportEvents(page)).filter((e) => e.task === "intervention").map((d) => d.tags!.find((t) => t.startsWith("outcome:")));
  expect(outcomes).toEqual(["outcome:shown", "outcome:postponed"]);
});
