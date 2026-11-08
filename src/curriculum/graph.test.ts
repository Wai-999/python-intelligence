import { describe, expect, it } from "vitest";
import type { Lesson } from "../content/types";
import type { LessonProgress } from "../progress/types";
import { buildGraph, isUnlocked, recommendNext, validateGraph, type ProgressMap } from "./graph";
import { computeMastery, emptyProgress, isComplete, stepCredit } from "./mastery";
import { feedbackForError, feedbackForTests } from "../tutor/feedback";
import { LESSONS } from "../content/lessons";

const L = (id: string, prerequisites: string[] = [], concepts: string[] = [], level: Lesson["level"] = 1): Lesson => ({
  id, title: id, summary: "", track: "python-core", level, estimated_minutes: 5, prerequisites, concepts,
  sources: [], license: "x", steps: [],
});

const P = (id: string, over: Partial<LessonProgress> = {}): LessonProgress => ({ ...emptyProgress(id), ...over });
const map = (...ps: LessonProgress[]): ProgressMap => new Map(ps.map((p) => [p.lessonId, p]));

describe("graph validation", () => {
  it("accepts the real curriculum", () => {
    expect(validateGraph(LESSONS)).toEqual([]);
  });
  it("rejects unknown prerequisites, cycles, duplicate ids and doubly-taught concepts", () => {
    expect(validateGraph([L("a", ["zz"])])).toContain("a: unknown prerequisite zz");
    expect(validateGraph([L("a", ["b"]), L("b", ["a"])])).toContain("prerequisite cycle detected");
    expect(validateGraph([L("a"), L("a")])).toContain("duplicate lesson id a");
    expect(validateGraph([L("a", [], ["x"]), L("b", [], ["x"])])).toContain("concept x taught by both a and b");
  });
  it("orders topologically and deterministically", () => {
    const g = buildGraph([L("c", ["a", "b"]), L("b", [], [], 2), L("a")]);
    expect(g.order).toEqual(["a", "b", "c"]);
  });
  it("continues the most recent chain before switching branches (ties at the same level)", () => {
    // root -> fn -> {side, loops}; loops -> strings. Alphabetically "side" < "strings", but strings continues the chain.
    const g = buildGraph([L("root"), L("fn", ["root"]), L("side", ["fn"], [], 2), L("loops", ["fn"]),
                          L("strings", ["loops"], [], 2)]);
    expect(g.order).toEqual(["root", "fn", "loops", "strings", "side"]);
  });
  it("puts the real core path in teaching order", () => {
    const order = buildGraph(LESSONS).order;
    const at = (id: string) => order.indexOf(id);
    expect(at("py-loops")).toBeLessThan(at("py-strings"));
    expect(at("py-strings")).toBeLessThan(at("py-lists"));
    expect(at("py-lists")).toBeLessThan(at("py-dicts"));
  });
});

describe("recommendation", () => {
  const g = buildGraph([L("a", [], ["names"]), L("b", ["a"], ["functions"]), L("c", ["b"])]);

  it("starts at the root, unlocks in order, and finishes", () => {
    expect(recommendNext(g, map())).toEqual({ kind: "next", lessonId: "a" });
    expect(isUnlocked(g, "b", map())).toBe(false);
    const done = map(P("a", { completed: true, mastery: 1 }));
    expect(isUnlocked(g, "b", done)).toBe(true);
    expect(recommendNext(g, done)).toEqual({ kind: "next", lessonId: "b" });
    const all = map(P("a", { completed: true }), P("b", { completed: true }), P("c", { completed: true }));
    expect(recommendNext(g, all)).toEqual({ kind: "done" });
  });

  it("continues a started lesson before suggesting new ones", () => {
    const m = map(P("a", { completed: true, mastery: 1 }), P("b", { furthestStep: 3 }));
    expect(recommendNext(g, m)).toEqual({ kind: "continue", lessonId: "b" });
  });

  it("remediates a weak prerequisite after repeated struggles", () => {
    const m = map(P("a", { completed: true, mastery: 0.6 }), P("b", { furthestStep: 4, struggles: { names: 3 } }));
    expect(recommendNext(g, m, "b")).toEqual({ kind: "remediate", lessonId: "a", concept: "names", because: "b" });
  });

  it("does not remediate a prerequisite that was mastered", () => {
    const m = map(P("a", { completed: true, mastery: 0.95 }), P("b", { furthestStep: 4, struggles: { names: 5 } }));
    expect(recommendNext(g, m, "b").kind).toBe("continue");
  });
});

describe("mastery", () => {
  const lesson = LESSONS.find((l) => l.id === "py-functions")!;
  it("rewards first-try success more than persistence, with a floor", () => {
    expect(stepCredit("guided", { passed: true, attempts: 1, updatedAt: "" })).toBe(1);
    expect(stepCredit("guided", { passed: true, attempts: 3, updatedAt: "" })).toBeCloseTo(0.8);
    expect(stepCredit("guided", { passed: true, attempts: 20, updatedAt: "" })).toBe(0.5);
    expect(stepCredit("quiz", { passed: false, attempts: 1, score: 0.5, updatedAt: "" })).toBe(0.5);
  });
  it("is complete only when every graded step passes", () => {
    const steps = Object.fromEntries(lesson.steps.map((s) => [s.id, { passed: true, attempts: 1, score: 1, updatedAt: "" }]));
    expect(isComplete(lesson, { steps })).toBe(true);
    expect(computeMastery(lesson, { steps })).toBe(1);
    expect(isComplete(lesson, { steps: {} })).toBe(false);
    expect(computeMastery(lesson, { steps: {} })).toBe(0);
  });
});

describe("offline tutor", () => {
  it("maps known errors to Socratic feedback", () => {
    const fb = feedbackForError({ type: "NameError", message: "name 'totl' is not defined", line: 3, summary: "" });
    expect(fb.diagnosis).toContain("totl");
    expect(fb.question).toMatch(/spelled/);
    expect(feedbackForError({ type: "Weird", message: "m", line: 1, summary: "" }).diagnosis).toContain("Weird");
  });
  it("summarises failing tests and passes silently when all pass", () => {
    expect(feedbackForTests([{ name: "t", passed: true, errorType: null, message: "" }])).toBeNull();
    const fb = feedbackForTests([
      { name: "zero", passed: false, errorType: "AssertionError", message: "expected 0" },
      { name: "one", passed: true, errorType: null, message: "" },
    ])!;
    expect(fb.diagnosis).toContain("1 of 2");
    expect(fb.action).toMatch(/edge case/);
  });
});
