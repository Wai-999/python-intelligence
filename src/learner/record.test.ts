import { describe, expect, it } from "vitest";
import type { ExerciseStep, Lesson, QuizStep } from "../content/types";
import { buildModel } from "./model";
import { assistanceFor, exerciseEvents, quizEvents, reviewEvent, reviewItem } from "./record";

const ex = (id: string, concepts: (string | undefined)[]): ExerciseStep =>
  ({ id, kind: "guided", title: id, body: "", starter: "", hints: [], solution: "", tests: concepts.map((c, i) => ({ name: `t${i}`, code: "", ...(c ? { concept: c } : {}) })) }) as unknown as ExerciseStep;
const quiz = (id: string, concepts: string[], pass_mark = 0.75): QuizStep =>
  ({ id, kind: "quiz", title: id, body: "", pass_mark,
     questions: concepts.map((c, i) => ({ id: `q${i}`, prompt: `about ${c}?`, choices: ["a", "b"], answer: 0, explanation: "", concept: c })) }) as unknown as QuizStep;
const lesson = (id: string, concepts: string[], steps: unknown[]): Lesson =>
  ({ id, title: id, summary: "", track: "python", level: 1, estimated_minutes: 5, prerequisites: [], concepts, sources: [], license: "", steps }) as unknown as Lesson;

const E1 = ex("e1", ["loops", "loops", "ranges"]);
const E2 = ex("e2", ["ranges", undefined]);
const Q = quiz("check", ["loops", "loops", "ranges"]);
const L = lesson("basics", ["loops", "ranges", "style"], [E1, E2, Q]);
let k = 0;
const stamp = { at: "2026-01-05T09:00:00.000Z", id: () => `id${++k}` };

describe("exercise events", () => {
  it("records each directly checked concept by its own checks, and untested concepts by the overall result", () => {
    const evs = exerciseEvents(L, E1, [{ concept: "loops", passed: true }, { concept: "loops", passed: true }, { concept: "ranges", passed: false }], 0, stamp);
    expect(evs.map((e) => [e.concept, e.passed, e.task, e.stepId, e.lessonId])).toEqual([
      ["loops", true, "exercise", "e1", "basics"], ["ranges", false, "exercise", "e1", "basics"], ["style", false, "exercise", "e1", "basics"]]);
    const ok = exerciseEvents(L, E1, [{ concept: "loops", passed: true }, { concept: "loops", passed: true }, { concept: "ranges", passed: true }], 2, stamp);
    expect(ok.map((e) => [e.concept, e.passed, e.assistance])).toEqual([["loops", true, 2], ["ranges", true, 2], ["style", true, 2]]);
    expect(new Set(ok.map((e) => e.id)).size).toBe(3);
  });

  it("fails every concept when the code didn't run, and needs all of a concept's checks", () => {
    expect(exerciseEvents(L, E1, null, 0, stamp).every((e) => !e.passed)).toBe(true);
    const partial = exerciseEvents(L, E1, [{ concept: "loops", passed: true }, { concept: "loops", passed: false }, { concept: "ranges", passed: true }], 0, stamp);
    expect(partial.find((e) => e.concept === "loops")!.passed).toBe(false);
    expect(exerciseEvents(L, E2, [{ concept: "ranges", passed: true }], 0, stamp).find((e) => e.concept === "style")!.passed).toBe(false);
  });

  it("ignores test concepts that aren't the lesson's", () => {
    const stray = ex("e3", ["loops", "telepathy"]);
    expect(exerciseEvents(lesson("b", ["loops"], [stray]), stray, [{ concept: "loops", passed: true }, { concept: "telepathy", passed: true }], 0, stamp)
      .map((e) => e.concept)).toEqual(["loops"]);
  });
});

describe("quiz events", () => {
  it("records a concept as passed only if all its questions were right; unasked concepts follow the pass mark", () => {
    const evs = quizEvents(L, Q, [true, false, true], stamp);
    expect(evs.map((e) => [e.concept, e.passed, e.task])).toEqual([["loops", false, "quiz"], ["ranges", true, "quiz"], ["style", false, "quiz"]]);
    expect(quizEvents(L, Q, [true, true, true], stamp).map((e) => e.passed)).toEqual([true, true, true]);
    expect(quizEvents(L, quiz("c", ["loops", "ranges", "ranges", "ranges"]), [false, true, true, true], stamp).find((e) => e.concept === "style")!.passed).toBe(true);
  });
});

describe("reviews", () => {
  it("asks only the concept's own questions, rotating through them", () => {
    expect(reviewItem([L], "loops", 0)!.question.id).toBe("q0");
    expect(reviewItem([L], "loops", 1)!.question.id).toBe("q1");
    expect(reviewItem([L], "loops", 2)!.question.id).toBe("q0");
    expect(reviewItem([L], "ranges", 7)!.question.id).toBe("q2");
    expect(reviewItem([L], "style", 1)).toBeNull(); // no question of its own: no review rather than an unrelated one
    expect(reviewItem([L], "unknown", 0)).toBeNull();
    expect(reviewItem([lesson("b", ["x"], [E1])], "x", 0)).toBeNull();
  });

  it("records a review event the model schedules", () => {
    const item = reviewItem([L], "loops", 0)!;
    const e = reviewEvent(item, true, stamp);
    expect([e.task, e.concept, e.lessonId, e.stepId, e.passed, e.assistance]).toEqual(["review", "loops", "basics", "review:q0", true, 0]);
    expect(buildModel([L], [e]).quarantined).toEqual([]);
  });
});

describe("assistance", () => {
  it("counts hints up to 3 and the solution as 4", () => {
    expect([assistanceFor(0, false), assistanceFor(1, false), assistanceFor(5, false), assistanceFor(0, true), assistanceFor(2, true)]).toEqual([0, 1, 3, 4, 4]);
  });
});
