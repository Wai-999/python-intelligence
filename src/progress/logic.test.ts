import { describe, expect, it } from "vitest";
import { LESSONS } from "../content/lessons";
import { applyOutcome, reconcile, visitStep } from "./logic";

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

describe("reconcile", () => {
  const graded = lesson.steps.filter((st) => st.kind === "guided" || st.kind === "challenge" || st.kind === "transfer" || st.kind === "quiz");
  const transfer = lesson.steps.find((st) => st.kind === "transfer")!;
  const pass = { passed: true, attempts: 1, updatedAt: "2026-11-01T10:00:00.000Z" };
  const stale = { lessonId: lesson.id, furthestStep: 5, completed: true, completedAt: "2026-11-01T10:00:00.000Z", mastery: 1, struggles: {},
    steps: Object.fromEntries(graded.filter((st) => st.id !== transfer.id).map((st) => [st.id, { ...pass, ...(st.kind === "quiz" ? { score: 1 } : {}) }])) };

  it("a completion saved before the transfer step existed no longer stands, and mastery is recomputed", () => {
    const r = reconcile(lesson, stale);
    expect(r.completed).toBe(false);
    expect(r.completedAt).toBeUndefined();
    expect(r.mastery).toBeLessThan(1);
    expect(r.steps).toEqual(stale.steps); // the earned step results are kept
    expect(stale.completed).toBe(true); // pure: the input is untouched
  });
  it("a completion that still holds keeps its date and is returned as is", () => {
    const full = { ...stale, steps: { ...stale.steps, [transfer.id]: pass } };
    expect(reconcile(lesson, full)).toBe(full);
  });
  it("a lesson whose steps all pass but wasn't marked complete becomes complete, dated by its latest step", () => {
    const r = reconcile(lesson, { ...stale, completed: false, completedAt: undefined, steps: { ...stale.steps, [transfer.id]: { ...pass, updatedAt: "2026-11-02T09:00:00.000Z" } } });
    expect(r.completed).toBe(true);
    expect(r.completedAt).toBe("2026-11-02T09:00:00.000Z");
  });
});
