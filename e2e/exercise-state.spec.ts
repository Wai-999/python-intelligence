import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import valuesNames from "../content/lessons/py-values-names.json" with { type: "json" };

// Exercise state belongs to one task of one lesson, survives imports correctly, and one run is one attempt.

type L = { steps: { id: string; kind: string; solution?: string; hints?: string[] }[] };
const lesson = valuesNames as unknown as L;
const circle = lesson.steps.findIndex((s) => s.id === "circle");

async function exportEvents(page: Page) {
  await page.getByRole("button", { name: "Progress" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export progress" }).click();
  const file = await (await download).path();
  const data = JSON.parse(readFileSync(file, "utf8"));
  await page.getByRole("button", { name: "Close" }).click();
  return data as { events: { stepId: string; assistance: number }[] };
}

test("help shown in one lesson's step doesn't carry into another lesson's step with the same id", async ({ page }) => {
  await page.goto("./#/lesson/ml-evaluation/5");
  await page.getByRole("button", { name: /Show a hint/ }).click();
  await expect(page.locator(".hint")).toHaveCount(1);
  await page.goto("./#/lesson/ml-trees/5"); // also a step called "split"
  await expect(page.getByRole("heading", { name: /Gini and the best split/ })).toBeVisible();
  await expect(page.locator(".hint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Show a hint/ })).toBeVisible();
});

test("importing progress into an open exercise shows and counts the imported help", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`./#/lesson/py-values-names/${circle}`);
  await expect(page.locator(".solution")).toHaveCount(0);
  const file = { format: "python-intelligence-progress", version: 2, exportedAt: "2026-03-02T09:00:00.000Z", lessons: [], drafts: {},
    position: null, events: [], assistance: { "py-values-names:circle": 4 } };
  await page.getByRole("button", { name: "Progress" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "p.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.getByText("Progress imported.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("One correct solution")).toBeVisible();
  await page.locator("textarea.editor-input").fill(lesson.steps[circle]!.solution!);
  await page.getByRole("button", { name: "▶ Run checks" }).click();
  await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
  const { events } = await exportEvents(page);
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((e) => e.stepId === "circle" && e.assistance === 4)).toBe(true);
});

test("pressing the run shortcut repeatedly during a run records one attempt", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`./#/lesson/py-values-names/${circle}`);
  const editor = page.locator("textarea.editor-input");
  await editor.fill(lesson.steps[circle]!.solution!);
  await editor.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByText("All checks pass")).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(500);
  const { events } = await exportEvents(page);
  const ids = new Set(events.map((e) => e.stepId));
  expect([...ids]).toEqual(["circle"]);
  // One run records one event per concept of the lesson (four here), not one batch per key press.
  expect(events.length).toBe(4);
});
