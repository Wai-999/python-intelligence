import { describe, expect, it } from "vitest";
import type { ExerciseStep, Lesson, QuizStep } from "../content/types";
import { LESSONS } from "../content/lessons";
import type { LearnerEvent } from "../learner/model";
import { exerciseEvents, quizEvents } from "../learner/record";
import { buildGraph } from "./graph";
import { completionOf, reviewDueFor, whyThisLesson } from "./standing";

const ex = (id: string): ExerciseStep => ({ id, kind: "guided", difficulty: 1, title: id, body: "", starter: "", hints: [], solution: "",
  tests: [{ name: "t", code: "", concept: "loops" }] }) as unknown as ExerciseStep;
const quiz = (id: string): QuizStep => ({ id, kind: "quiz", title: id, body: "", pass_mark: 0.5,
  questions: [{ id: "q1", prompt: "?", choices: ["a", "b"], answer: 0, explanation: "", concept: "loops" },
              { id: "q2", prompt: "?", choices: ["a", "b"], answer: 0, explanation: "", concept: "loops" }] }) as unknown as QuizStep;
const E = ex("e"), Q = quiz("q");
const L = { id: "basics", title: "b", summary: "", track: "python-core", level: 1, estimated_minutes: 5, prerequisites: [], concepts: ["loops"],
  sources: [], license: "", steps: [E, Q] } as unknown as Lesson;
let n = 0;
const at = (m: number) => ({ at: `2026-11-14T10:${String(m).padStart(2, "0")}:00Z`, id: () => `e${++n}` });
const passEx = (m: number, help = 0) => exerciseEvents(L, E, [{ concept: "loops", passed: true }], help as 0, at(m));
const failEx = (m: number) => exerciseEvents(L, E, [{ concept: "loops", passed: false }], 0, at(m));
// One of two questions right: the quiz passes (pass mark 0.5) although the concept's own result is a fail.
const halfQuiz = (m: number, help = 0) => quizEvents(L, Q, [true, false], at(m), help as 0);

describe("how a lesson was completed", () => {
  it("independent when every graded step has an unaided passing attempt", () => {
    expect(completionOf(L, [...failEx(1), ...passEx(2), ...halfQuiz(3)])).toBe("independent");
  });
  it("uses the whole step's result, not each concept's: a quiz passed at its pass mark counts", () => {
    expect(halfQuiz(3).every((e) => e.passed === false && e.stepPassed === true)).toBe(true);
    expect(completionOf(L, [...passEx(2), ...halfQuiz(3)])).toBe("independent");
  });
  it("assisted when a step was passed only with help", () => {
    expect(completionOf(L, [...passEx(2, 4), ...halfQuiz(3)])).toBe("assisted"); // the solution was shown
    expect(completionOf(L, [...passEx(2), ...halfQuiz(3, 4)])).toBe("assisted"); // retaken after answers were revealed
  });
  it("an unaided pass anywhere outweighs earlier help on the same step", () => {
    expect(completionOf(L, [...passEx(1, 2), ...passEx(2), ...halfQuiz(3)])).toBe("independent");
  });
  it("older quiz events without whole-step results never count as independent", () => {
    const legacy: LearnerEvent[] = halfQuiz(3).map(({ stepPassed: _drop, ...e }) => e);
    expect(completionOf(L, [...passEx(2), ...legacy])).toBe("unknown");
    // ...nor turn an assisted step into an unknown one when they can't have been the pass
    expect(completionOf(L, [...passEx(2, 4), ...legacy])).toBe("assisted");
  });
  it("older exercise events are judged by their concepts' results", () => {
    const legacy: LearnerEvent[] = passEx(2).map(({ stepPassed: _drop, ...e }) => e);
    expect(completionOf(L, [...legacy, ...halfQuiz(3)])).toBe("independent");
  });
  it("a step with no recorded attempt (e.g. imported from a version 1 backup) is unknown", () => {
    expect(completionOf(L, passEx(2))).toBe("unknown");
  });
  it("ignores other lessons' events and non-attempt events", () => {
    const other = passEx(2, 4).map((e) => ({ ...e, lessonId: "elsewhere" }));
    expect(completionOf(L, [...other, ...passEx(3), ...halfQuiz(4)])).toBe("independent");
  });
});

describe("why this lesson", () => {
  const g = buildGraph(LESSONS);
  it("names what a lesson builds on and what it opens", () => {
    const w = whyThisLesson(g, "py-functions");
    expect(w.buildsOn).toEqual(["py-values-names"]);
    expect(w.opens).toEqual(expect.arrayContaining(["py-conditionals", "py-scope-defaults"]));
    expect(whyThisLesson(g, "py-values-names").buildsOn).toEqual([]);
  });
  it("every lesson either opens another or is the end of a path, and the result follows the graph", () => {
    for (const id of g.order) {
      const w = whyThisLesson(g, id);
      for (const o of w.opens) expect(g.byId.get(o)!.prerequisites).toContain(id);
      expect(w.buildsOn).toEqual(g.byId.get(id)!.prerequisites);
    }
    expect(whyThisLesson(g, "nope")).toEqual({ buildsOn: [], opens: [] });
  });
});

describe("review due on the map", () => {
  it("is due when any concept the lesson teaches is in the due set", () => {
    expect(reviewDueFor(L, new Set(["loops"]))).toBe(true);
    expect(reviewDueFor(L, new Set(["other"]))).toBe(false);
  });
});
