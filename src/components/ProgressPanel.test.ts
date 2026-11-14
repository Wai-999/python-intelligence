import { describe, expect, it } from "vitest";
import { lastSaved } from "./ProgressPanel";
import type { ProgressExport } from "../progress/types";

const base: ProgressExport = { format: "python-intelligence-progress", version: 2, exportedAt: "2026-11-14T00:00:00.000Z",
  lessons: [], drafts: {}, position: null, events: [], assistance: {} } as unknown as ProgressExport;

describe("lastSaved", () => {
  it("is null when nothing with a time has been saved, drafts included", () => {
    expect(lastSaved({ ...base, drafts: { "py-values-names:circle": "x = 1" } })).toBeNull();
  });
  it("takes the newest of step results, learner events and the reading position", () => {
    const data = {
      ...base,
      lessons: [{ lessonId: "a", steps: { s: { passed: true, attempts: 1, updatedAt: "2026-11-10T09:00:00.000Z" } } }],
      events: [{ at: "2026-11-12T09:00:00.000Z" }],
      position: { lessonId: "a", stepIndex: 0, updatedAt: "2026-11-11T09:00:00.000Z" },
    } as unknown as ProgressExport;
    expect(lastSaved(data)).toBe("2026-11-12T09:00:00.000Z");
    expect(lastSaved({ ...data, position: { lessonId: "a", stepIndex: 1, updatedAt: "2026-11-13T09:00:00.000Z" } })).toBe("2026-11-13T09:00:00.000Z");
  });
});
