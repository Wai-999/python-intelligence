import { describe, expect, it } from "vitest";
import type { Lesson } from "../content/types";
import { buildModel, dueReviews, POLICY_VERSION, type Assistance, type LearnerEvent, type Task } from "./model";

const lesson = (id: string, concepts: string[], prerequisites: string[] = []) =>
  ({ id, title: id, summary: "", track: "python", level: 1, estimated_minutes: 10, prerequisites, concepts, sources: [], license: "", steps: [] }) as unknown as Lesson;
const LESSONS = [lesson("basics", ["loops"]), lesson("next", ["functions"], ["basics"])];

const T0 = Date.parse("2026-01-05T09:00:00.000Z");
const at = (days: number, hours = 0) => new Date(T0 + days * 86400000 + hours * 3600000).toISOString();
let n = 0;
const ev = (when: string, concept: string, task: Task, passed: boolean, assistance: Assistance = 0, stepId = "s1", lessonId = "basics"): LearnerEvent =>
  ({ id: `e${String(++n).padStart(4, "0")}`, at: when, lessonId, stepId, task, concept, passed, assistance, policy: POLICY_VERSION });
const state = (events: LearnerEvent[], c = "loops") => buildModel(LESSONS, events).get(c)!;

describe("evidence and the advancement gate", () => {
  it("starts new, with every concept of every lesson present", () => {
    const m = buildModel(LESSONS, []);
    expect([...m.keys()].sort()).toEqual(["functions", "loops"]);
    expect(m.get("loops")!.status).toBe("new");
    expect(m.get("loops")!.reviewDue).toBeNull();
  });

  it("does not grant mastery for assisted successes, repeats of one task, or a missing explanation check", () => {
    const helped = [ev(at(0), "loops", "exercise", true, 2, "a"), ev(at(0, 1), "loops", "exercise", true, 4, "b"), ev(at(0, 2), "loops", "quiz", true)];
    expect(state(helped).status).toBe("learning");
    expect(state(helped).assistedSuccesses).toBe(2);
    const sameTask = [ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0, 1), "loops", "exercise", true, 0, "a"), ev(at(0, 2), "loops", "quiz", true)];
    expect(state(sameTask).independentTasks).toEqual(["basics:a"]);
    expect(state(sameTask).gateMetAt).toBeNull();
    const noQuiz = [ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0, 1), "loops", "exercise", true, 0, "b")];
    expect(state(noQuiz).status).toBe("learning");
    const failedQuiz = [...noQuiz, ev(at(0, 2), "loops", "quiz", false)];
    expect(state(failedQuiz).gateMetAt).toBeNull();
  });

  it("opens the gate on two independent tasks plus an explanation check, in either order", () => {
    const events = [ev(at(0), "loops", "quiz", true), ev(at(0, 1), "loops", "exercise", true, 0, "a"), ev(at(0, 2), "loops", "exercise", true, 0, "b")];
    const s = state(events);
    expect(s.status).toBe("complete");
    expect(s.gateMetAt).toBe(at(0, 2));
    expect(s.reviewDue).toBe(at(1, 2));
    expect(s.durable).toBe(false);
  });

  it("keeps a concept 'learning' while its prerequisites are not complete", () => {
    const own = [ev(at(0), "functions", "exercise", true, 0, "a", "next"), ev(at(0, 1), "functions", "exercise", true, 0, "b", "next"), ev(at(0, 2), "functions", "quiz", true, 0, "q", "next")];
    expect(state(own, "functions").prerequisitesMet).toBe(false);
    expect(state(own, "functions").status).toBe("learning");
    const prereq = [ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0), "loops", "exercise", true, 0, "b"), ev(at(0), "loops", "quiz", true)];
    expect(state([...own, ...prereq], "functions").status).toBe("complete");
  });
});

describe("spaced reviews: a two-week replay", () => {
  const gate = [ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0, 1), "loops", "exercise", true, 0, "b"), ev(at(0, 2), "loops", "quiz", true)];
  it("schedules 1, then 3, then 7 days; becomes durable after two spaced reviews; a lapse resets it", () => {
    const log = [...gate];
    expect(dueReviews(buildModel(LESSONS, log), at(0, 23)).map((s) => s.concept)).toEqual([]);
    expect(dueReviews(buildModel(LESSONS, log), at(1, 2)).map((s) => s.concept)).toEqual(["loops"]);

    log.push(ev(at(1, 3), "loops", "review", true));
    let s = state(log);
    expect([s.reviewStage, s.successfulReviews, s.reviewDue, s.status]).toEqual([1, 1, at(4, 3), "complete"]);

    log.push(ev(at(2), "loops", "review", true)); // early: practice only
    expect(state(log).reviewDue).toBe(at(4, 3));
    expect(state(log).successfulReviews).toBe(1);

    log.push(ev(at(4, 5), "loops", "review", true));
    s = state(log);
    expect([s.reviewStage, s.successfulReviews, s.reviewDue, s.status]).toEqual([2, 2, at(11, 5), "mastered"]);
    expect(dueReviews(buildModel(LESSONS, log), at(10)).length).toBe(0);
    expect(dueReviews(buildModel(LESSONS, log), at(11, 6)).map((x) => x.concept)).toEqual(["loops"]);

    log.push(ev(at(12), "loops", "review", false));
    s = state(log);
    expect([s.reviewStage, s.successfulReviews, s.durable, s.status, s.reviewDue]).toEqual([0, 0, false, "complete", at(13)]);
  });

  it("treats a review recalled only with help as a lapse", () => {
    const log = [...gate, ev(at(1, 3), "loops", "review", true, 3)];
    const s = state(log);
    expect([s.reviewStage, s.successfulReviews, s.reviewDue]).toEqual([0, 0, at(2, 3)]);
  });

  it("orders reviews by how overdue they are", () => {
    const fn = [ev(at(0), "functions", "exercise", true, 0, "a", "next"), ev(at(0), "functions", "exercise", true, 0, "b", "next"), ev(at(0), "functions", "quiz", true, 0, "q", "next")];
    expect(dueReviews(buildModel(LESSONS, [...gate, ...fn]), at(3)).map((s) => s.concept)).toEqual(["functions", "loops"]);
  });
});

describe("hint fading and restoration", () => {
  it("eases off after two independent successes and restores after two failures", () => {
    const log: LearnerEvent[] = [];
    expect(state(log).hintTier).toBe(2);
    log.push(ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0, 1), "loops", "exercise", true, 0, "b"));
    expect(state(log).hintTier).toBe(1);
    log.push(ev(at(0, 2), "loops", "exercise", true, 0, "c"), ev(at(0, 3), "loops", "exercise", true, 0, "d"));
    expect(state(log).hintTier).toBe(0);
    log.push(ev(at(0, 4), "loops", "exercise", true, 0, "e"), ev(at(0, 5), "loops", "exercise", true, 0, "f"));
    expect(state(log).hintTier).toBe(0);
    log.push(ev(at(0, 6), "loops", "exercise", false), ev(at(0, 7), "loops", "exercise", false));
    expect(state(log).hintTier).toBe(1);
  });

  it("needs consecutive results: an assisted success breaks a streak", () => {
    const log = [ev(at(0), "loops", "exercise", false), ev(at(0, 1), "loops", "exercise", true, 2), ev(at(0, 2), "loops", "exercise", false)];
    expect(state(log).hintTier).toBe(2);
  });
});

describe("replays are deterministic", () => {
  it("gives the same state whatever order the events are stored in", () => {
    const log = [ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0, 1), "loops", "exercise", true, 0, "b"), ev(at(0, 2), "loops", "quiz", true), ev(at(1, 3), "loops", "review", true)];
    expect(state([...log].reverse())).toEqual(state(log));
  });

  it("labels the estimate a heuristic between 0 and 1 and reports how much evidence backs it", () => {
    const s = state([ev(at(0), "loops", "exercise", true, 0, "a")]);
    expect(s.masteryEstimate).toBeGreaterThan(0);
    expect(s.masteryEstimate).toBeLessThanOrEqual(1);
    expect([s.evidence, s.uncertainty]).toEqual([1, "high"]);
  });
});
