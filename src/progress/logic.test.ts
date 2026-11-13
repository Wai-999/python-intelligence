import { describe, expect, it } from "vitest";
import { LESSONS } from "../content/lessons";
import { applyOutcome, visitStep } from "./logic";

const lesson = LESSONS.find((l) => l.id === "py-values-names")!;

describe("applyOutcome", () => {
  it("counts attempts, tracks struggles, and keeps a pass sticky", () => {
    let p = applyOutcome(lesson, undefined, "circle", { passed: false, attempt: true, failedConcepts: ["expressions"] });
    expect(p.steps.circle).toMatchObject({ passed: false, attempts: 1 });
    expect(p.struggles.expressions).toBe(1);
    p = applyOutcome(lesson, p, "circle", { passed: true, attempt: true });
    p = applyOutcome(lesson, p, "circle", { passed: false, attempt: true, failedConcepts: ["names"] });
    expect(p.steps.circle).toMatchObject({ passed: true, attempts: 3 });
  });

  it("completes the lesson when all graded steps pass, and mastery stays in 0..1", () => {
    let p = applyOutcome(lesson, undefined, "circle", { passed: true, attempt: true });
    expect(p.completed).toBe(false);
    p = applyOutcome(lesson, p, "check", { passed: true, score: 1, attempt: true });
    expect(p.completed).toBe(false); // the transfer problem is graded too
    p = applyOutcome(lesson, p, "bill", { passed: true, attempt: true });
    expect(p.completed).toBe(true);
    expect(p.completedAt).toBeTruthy();
    expect(p.mastery).toBeGreaterThan(0.99);
    expect(p.mastery).toBeLessThanOrEqual(1);
  });

  it("keeps the best quiz score", () => {
    let p = applyOutcome(lesson, undefined, "check", { passed: true, score: 1, attempt: true });
    p = applyOutcome(lesson, p, "check", { passed: false, score: 0.33, attempt: true });
    expect(p.steps.check!.score).toBe(1);
  });

  it("does not mutate its input", () => {
    const p0 = applyOutcome(lesson, undefined, "circle", { passed: false, attempt: true });
    const snap = JSON.stringify(p0);
    applyOutcome(lesson, p0, "circle", { passed: true, attempt: true });
    expect(JSON.stringify(p0)).toBe(snap);
  });
});

describe("visitStep", () => {
  it("only moves furthestStep forward and clamps to the lesson", () => {
    let p = visitStep(lesson, undefined, 3);
    p = visitStep(lesson, p, 1);
    expect(p.furthestStep).toBe(3);
    expect(visitStep(lesson, p, 99).furthestStep).toBe(lesson.steps.length - 1);
  });
});
