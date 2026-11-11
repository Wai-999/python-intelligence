import { describe, expect, it } from "vitest";
import type { Lesson } from "../content/types";
import { buildModel, dueReviews, LearnerDataError, MAX_AUTO_HINT_TIER, POLICY_VERSION, type Assistance, type LearnerEvent, type Task } from "./model";

const lesson = (id: string, concepts: string[], prerequisites: string[] = []) =>
  ({ id, title: id, summary: "", track: "python", level: 1, estimated_minutes: 10, prerequisites, concepts, sources: [], license: "", steps: [] }) as unknown as Lesson;
const LESSONS = [lesson("basics", ["loops"]), lesson("next", ["functions"], ["basics"]), lesson("third", ["classes"], ["next"])];
const OWNER: Record<string, string> = { loops: "basics", functions: "next", classes: "third" };

const T0 = Date.parse("2026-01-05T09:00:00.000Z");
const at = (days: number, hours = 0) => new Date(T0 + days * 86400000 + hours * 3600000).toISOString();
let n = 0;
const ev = (when: string, concept: string, task: Task, passed: boolean, assistance: Assistance = 0, stepId = "s1"): LearnerEvent =>
  ({ id: `e${String(++n).padStart(4, "0")}`, at: when, lessonId: OWNER[concept] ?? "basics", stepId, task, concept, passed, assistance, policy: POLICY_VERSION });
const model = (events: unknown[]) => buildModel(LESSONS, events);
const state = (events: unknown[], c = "loops") => model(events).concepts.get(c)!;
/** Two distinct independent exercises and a passed quiz: the concept's own evidence. */
const evidence = (c: string, d = 0) => [ev(at(d), c, "exercise", true, 0, "a"), ev(at(d, 1), c, "exercise", true, 0, "b"), ev(at(d, 2), c, "quiz", true, 0, "q")];

describe("evidence and the advancement gate", () => {
  it("starts new, with every concept of every lesson present", () => {
    const m = model([]);
    expect([...m.concepts.keys()].sort()).toEqual(["classes", "functions", "loops"]);
    expect(m.concepts.get("loops")!.status).toBe("new");
    expect(m.concepts.get("loops")!.reviewDue).toBeNull();
  });

  it("does not grant completion for assisted successes, repeats of one task, or a missing explanation check", () => {
    const helped = [ev(at(0), "loops", "exercise", true, 2, "a"), ev(at(0, 1), "loops", "exercise", true, 4, "b"), ev(at(0, 2), "loops", "quiz", true)];
    expect(state(helped).status).toBe("learning");
    expect(state(helped).assistedSuccesses).toBe(2);
    const sameTask = [ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0, 1), "loops", "exercise", true, 0, "a"), ev(at(0, 2), "loops", "quiz", true)];
    expect(state(sameTask).independentTasks).toEqual(["basics:a"]);
    expect(state(sameTask).completedAt).toBeNull();
    const noQuiz = evidence("loops").slice(0, 2);
    expect(state(noQuiz).status).toBe("learning");
    expect(state([...noQuiz, ev(at(0, 3), "loops", "quiz", false)]).completedAt).toBeNull();
  });

  it("counts neither reviews before completion nor an assisted quiz towards the gate", () => {
    const early = [ev(at(0), "loops", "review", true, 0, "r1"), ev(at(0, 1), "loops", "review", true, 0, "r2"), ev(at(0, 2), "loops", "quiz", true)];
    expect([state(early).independentTasks, state(early).completedAt, state(early).status]).toEqual([[], null, "learning"]);
    const helpedQuiz = [ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0, 1), "loops", "exercise", true, 0, "b"), ev(at(0, 2), "loops", "quiz", true, 1)];
    expect([state(helpedQuiz).explanationChecked, state(helpedQuiz).completedAt]).toEqual([false, null]);
  });

  it("counts assisted successes of every kind of task", () => {
    const log = [...evidence("loops"), ev(at(0, 3), "loops", "quiz", true, 2), ev(at(1, 3), "loops", "review", true, 1), ev(at(1, 4), "loops", "exercise", true, 4, "c")];
    expect(state(log).assistedSuccesses).toBe(3);
  });

  it("completes on two independent tasks plus an explanation check, in either order", () => {
    const s = state([ev(at(0), "loops", "quiz", true), ev(at(0, 1), "loops", "exercise", true, 0, "a"), ev(at(0, 2), "loops", "exercise", true, 0, "b")]);
    expect([s.status, s.completedAt, s.reviewDue, s.durable]).toEqual(["complete", at(0, 2), at(1, 2), false]);
  });

  it("follows prerequisites recursively and schedules reviews only once the whole chain is complete", () => {
    // classes and functions have their own evidence on day 0; loops (the root) only on day 3.
    const log = [...evidence("classes"), ...evidence("functions"), ev(at(2), "classes", "review", true)];
    for (const c of ["functions", "classes"]) {
      const s = state(log, c);
      expect([s.evidenceReady, s.prerequisitesMet, s.status, s.reviewDue]).toEqual([true, false, "learning", null]);
    }
    log.push(...evidence("loops", 3));
    const m = model(log);
    for (const c of ["loops", "functions", "classes"]) {
      const s = m.concepts.get(c)!;
      expect([s.status, s.completedAt, s.reviewDue, s.successfulReviews]).toEqual(["complete", at(3, 2), at(4, 2), 0]);
    }
  });

  it("fails closed when a prerequisite lesson is missing from the curriculum", () => {
    const lessons = [lesson("orphan", ["x"], ["nowhere"])];
    const e = [ev(at(0), "x", "exercise", true, 0, "a"), ev(at(0), "x", "exercise", true, 0, "b"), ev(at(0), "x", "quiz", true)].map((v) => ({ ...v, lessonId: "orphan" }));
    const s = buildModel(lessons, e).concepts.get("x")!;
    expect([s.evidenceReady, s.prerequisitesMet, s.status]).toEqual([true, false, "learning"]);
  });
});

describe("spaced reviews: a replay over seven weeks", () => {
  it("schedules 1, 3, 7, 14 and then 30 days; durable after two spaced reviews; a lapse resets it", () => {
    const log = [...evidence("loops")];
    expect(dueReviews(model(log), at(0, 23)).map((s) => s.concept)).toEqual([]);
    expect(dueReviews(model(log), at(1, 2)).map((s) => s.concept)).toEqual(["loops"]);

    log.push(ev(at(1, 3), "loops", "review", true));
    let s = state(log);
    expect([s.reviewStage, s.successfulReviews, s.reviewDue, s.status]).toEqual([1, 1, at(4, 3), "complete"]);
    log.push(ev(at(2), "loops", "review", true)); // early: practice only
    expect([state(log).reviewDue, state(log).successfulReviews]).toEqual([at(4, 3), 1]);
    log.push(ev(at(4, 5), "loops", "review", true));
    s = state(log);
    expect([s.reviewStage, s.successfulReviews, s.reviewDue, s.status]).toEqual([2, 2, at(11, 5), "mastered"]);
    expect(dueReviews(model(log), at(10)).length).toBe(0);
    log.push(ev(at(11, 5), "loops", "review", true));
    expect([state(log).reviewStage, state(log).reviewDue]).toEqual([3, at(25, 5)]);
    log.push(ev(at(25, 5), "loops", "review", true));
    expect([state(log).reviewStage, state(log).reviewDue]).toEqual([4, at(55, 5)]);
    log.push(ev(at(55, 5), "loops", "review", true));
    expect([state(log).reviewStage, state(log).reviewDue]).toEqual([4, at(85, 5)]);

    log.push(ev(at(86), "loops", "review", false));
    s = state(log);
    expect([s.reviewStage, s.successfulReviews, s.durable, s.status, s.reviewDue]).toEqual([0, 0, false, "complete", at(87)]);
  });

  it("counts an early failed or assisted review as a lapse, even after mastery", () => {
    const mastered = [...evidence("loops"), ev(at(1, 3), "loops", "review", true), ev(at(4, 5), "loops", "review", true)];
    expect(state(mastered).status).toBe("mastered");
    for (const lapse of [ev(at(6), "loops", "review", false), ev(at(6), "loops", "review", true, 2)]) {
      const s = state([...mastered, lapse]);
      expect([s.status, s.durable, s.reviewStage, s.successfulReviews, s.reviewDue]).toEqual(["complete", false, 0, 0, at(7)]);
    }
  });

  it("treats a review recalled only with help as a lapse", () => {
    const s = state([...evidence("loops"), ev(at(1, 3), "loops", "review", true, 3)]);
    expect([s.reviewStage, s.successfulReviews, s.reviewDue]).toEqual([0, 0, at(2, 3)]);
  });

  it("puts the most overdue review first, whatever the names", () => {
    const log = [...evidence("loops"), ...evidence("functions", 1)];
    // loops is due on day 1, functions (completed on day 1) on day 2: loops first, although "functions" sorts first.
    expect(dueReviews(model(log), at(3)).map((s) => s.concept)).toEqual(["loops", "functions"]);
  });

  it("orders reviews by how overdue they are", () => {
    const log = [...evidence("loops", 1), ...evidence("functions", 1)].map((e, i) => ({ ...e, at: at(1, i < 3 ? 5 : 1) }));
    // functions' evidence is earlier, but it completes only when loops does (day 1, 05:00): equal due times sort by name.
    expect(dueReviews(model(log), at(3)).map((s) => s.concept)).toEqual(["functions", "loops"]);
  });
});

describe("hint fading and restoration", () => {
  it("eases off after two independent successes and restores after two failures, automatically only up to tier 3", () => {
    const log: LearnerEvent[] = [];
    expect(state(log).hintTier).toBe(2);
    log.push(ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0, 1), "loops", "exercise", true, 0, "b"));
    expect(state(log).hintTier).toBe(1);
    log.push(ev(at(0, 2), "loops", "exercise", true, 0, "c"), ev(at(0, 3), "loops", "exercise", true, 0, "d"));
    expect(state(log).hintTier).toBe(0);
    log.push(ev(at(0, 4), "loops", "exercise", true, 0, "e"), ev(at(0, 5), "loops", "exercise", true, 0, "f"));
    expect(state(log).hintTier).toBe(0);
    for (let i = 0; i < 12; i++) log.push(ev(at(1, i), "loops", "exercise", false));
    expect(state(log).hintTier).toBe(MAX_AUTO_HINT_TIER);
    expect(MAX_AUTO_HINT_TIER).toBe(3);
  });

  it("restores only after two comparable failures (the same kind of task)", () => {
    const mixed = [ev(at(0), "loops", "exercise", false), ev(at(0, 1), "loops", "quiz", false), ev(at(0, 2), "loops", "exercise", false), ev(at(0, 3), "loops", "review", false)];
    expect(state(mixed).hintTier).toBe(2);
    expect(state([ev(at(0), "loops", "exercise", false, 0, "a"), ev(at(0, 1), "loops", "exercise", false, 0, "b")]).hintTier).toBe(3);
    expect(state([ev(at(0), "loops", "quiz", false), ev(at(0, 1), "loops", "quiz", false)]).hintTier).toBe(3);
  });

  it("eases off only after consecutive independent successes: an assisted success of any kind breaks the streak", () => {
    for (const helped of [ev(at(0, 1), "loops", "exercise", true, 2, "h"), ev(at(0, 1), "loops", "quiz", true, 1, "hq"), ev(at(0, 1), "loops", "review", true, 3, "hr")]) {
      const log = [ev(at(0), "loops", "exercise", true, 0, "a"), helped, ev(at(0, 2), "loops", "exercise", true, 0, "b")];
      expect(state(log).hintTier).toBe(2);
      log.push(ev(at(0, 3), "loops", "exercise", true, 0, "c"));
      expect(state(log).hintTier).toBe(1);
    }
  });

  it("needs consecutive results: an assisted success breaks a streak", () => {
    expect(state([ev(at(0), "loops", "exercise", false), ev(at(0, 1), "loops", "exercise", true, 2), ev(at(0, 2), "loops", "exercise", false)]).hintTier).toBe(2);
  });
});

describe("the heuristic estimate", () => {
  it("stays in [0, 1], keeps its failure penalty while hints are restored, and recovers on success", () => {
    const fails = (k: number) => Array.from({ length: k }, (_, i) => ev(at(0, i), "loops", "exercise", false));
    const one = state([ev(at(0), "loops", "exercise", true, 0, "a"), ...fails(1).map((e) => ({ ...e, at: at(0, 1) }))]);
    const two = state([ev(at(0), "loops", "exercise", true, 0, "a"), ...fails(2).map((e, i) => ({ ...e, at: at(0, 1 + i) }))]);
    expect(one.masteryEstimate).toBeCloseTo(0.15);
    expect(two.masteryEstimate).toBeCloseTo(0.05);
    expect(state(fails(9)).masteryEstimate).toBe(0);
    const recovered = state([ev(at(0), "loops", "exercise", true, 0, "a"), ...fails(2).map((e, i) => ({ ...e, at: at(0, 1 + i) })), ev(at(0, 4), "loops", "exercise", true, 0, "b")]);
    expect([recovered.recentFailures, recovered.masteryEstimate]).toEqual([0, 0.5]);
    const helped = state([ev(at(0), "loops", "exercise", true, 0, "a"), ...fails(2).map((e, i) => ({ ...e, at: at(0, 1 + i) })), ev(at(0, 4), "loops", "exercise", true, 2, "b")]);
    expect([helped.recentFailures, helped.masteryEstimate]).toEqual([0, 0.3]);
    expect(state([...evidence("loops"), ev(at(1, 3), "loops", "review", true), ev(at(4, 3), "loops", "review", true)]).masteryEstimate).toBe(0.9);
    expect([state(fails(1)).evidence, state(fails(1)).uncertainty, state(fails(4)).uncertainty, state(fails(6)).uncertainty]).toEqual([1, "high", "medium", "low"]);
  });
});

describe("diagnostics the master prompt asks for", () => {
  it("reports hint dependency as the share of successes that needed help, unknown before any success", () => {
    expect(state([ev(at(0), "loops", "exercise", false)]).hintDependency).toBeNull();
    expect(state([ev(at(0), "loops", "exercise", true, 0, "a"), ev(at(0, 1), "loops", "exercise", true, 3, "b"), ev(at(0, 2), "loops", "exercise", true, 4, "c"),
      ev(at(0, 3), "loops", "exercise", true, 1, "d")]).hintDependency).toBe(0.75);
  });

  it("reports a misconception tag only when it recurs on failures, never from one slip", () => {
    const tagged = (when: string, passed: boolean, tags: string[]) => ({ ...ev(when, "loops", "exercise", passed), tags });
    expect(state([tagged(at(0), false, ["off-by-one"])]).misconceptionTags).toEqual([]);
    expect(state([tagged(at(0), false, ["off-by-one", "off-by-one"])]).misconceptionTags).toEqual([]);
    expect(state([tagged(at(0), false, ["off-by-one"]), tagged(at(0, 1), true, ["off-by-one"])]).misconceptionTags).toEqual([]);
    const log = [tagged(at(0), false, ["typo"]), tagged(at(0, 1), false, ["off-by-one"]), tagged(at(0, 2), false, ["off-by-one", "scope"]), tagged(at(0, 3), false, ["scope"]), tagged(at(0, 4), false, ["off-by-one"])];
    expect(state(log).misconceptionTags).toEqual(["off-by-one", "scope"]);
  });

  it("compares self-rated confidence with results, unknown without ratings", () => {
    expect(state([ev(at(0), "loops", "exercise", true)]).confidenceCalibration).toBeNull();
    const rated = (when: string, passed: boolean, confidence: 1 | 2 | 3 | 4 | 5) => ({ ...ev(when, "loops", "exercise", passed), confidence });
    expect(state([rated(at(0), false, 5), rated(at(0, 1), false, 5)]).confidenceCalibration).toBe(1);
    expect(state([rated(at(0), true, 1), rated(at(0, 1), true, 1)]).confidenceCalibration).toBe(-1);
    expect(state([rated(at(0), true, 5), rated(at(0, 1), false, 1), ev(at(0, 2), "loops", "exercise", false)]).confidenceCalibration).toBe(0);
  });
});

describe("validation and replay", () => {
  it("gives the same state whatever order the events are stored in, including equal times (ties by id)", () => {
    const same = at(0, 1);
    const log = [ev(same, "loops", "exercise", false), ev(same, "loops", "exercise", false), ev(same, "loops", "exercise", true, 0, "a"),
      ev(same, "loops", "exercise", true, 0, "b"), ev(same, "loops", "quiz", true)];
    const forward = state(log);
    expect(state([...log].reverse())).toEqual(forward);
    expect(state([log[2], log[0], log[4], log[1], log[3]])).toEqual(forward);
    expect(forward.hintTier).toBe(2); // fail, fail (tier 3), then two successes (tier 2): only the id order says so
  });

  it("treats the same instant in different offsets as equal", () => {
    const a = ev("2026-01-05T09:00:00.000Z", "loops", "exercise", true, 0, "a");
    const b = { ...ev("2026-01-05T10:30:00+01:30", "loops", "exercise", true, 0, "b") };
    const q = ev("2026-01-05T04:00:00-05:00", "loops", "quiz", true);
    expect(state([a, b, q]).completedAt).toBe("2026-01-05T09:00:00.000Z");
    expect(dueReviews(model([a, b, q]), "2026-01-06T10:00:00+01:00").length).toBe(1);
  });

  it("rejects invalid events and times with a LearnerDataError", () => {
    const good = ev(at(0), "loops", "exercise", true);
    for (const bad of [{ ...good, at: "2026-01-05 09:00" }, { ...good, at: "2026-01-05T09:00:00" }, { ...good, at: "2026-02-30T09:00:00Z" },
      { ...good, at: "yesterday" }, { ...good, passed: "yes" }, { ...good, assistance: 5 }, { ...good, assistance: 1.5 }, { ...good, task: "test" },
      { ...good, id: "" }, { ...good, tags: "typo" }, { ...good, tags: [""] }, { ...good, confidence: 0 }, { ...good, confidence: 3.5 }, null, 7]) {
      expect(() => model([bad])).toThrow(LearnerDataError);
    }
    expect(() => dueReviews(model([]), "now")).toThrow(LearnerDataError);
  });

  it("counts an event id once, and rejects two different events sharing an id", () => {
    const a = ev(at(0), "loops", "exercise", true, 0, "a");
    const b = ev(at(0, 1), "loops", "exercise", true, 0, "b");
    const q = ev(at(0, 2), "loops", "quiz", true);
    const f = ev(at(0, 3), "loops", "exercise", false);
    const doubled = state([a, a, b, q, f, f, f, { ...a }]);
    expect([doubled.evidence, doubled.failures, doubled.independentTasks.length]).toEqual([4, 1, 2]);
    expect(state([q, f, b, a, f, a])).toEqual(state([a, b, q, f]));
    expect(() => model([a, { ...a, passed: false }])).toThrow(LearnerDataError);
  });

  it("quarantines events for unknown concepts or the wrong lesson, never counting them", () => {
    const stray = [{ ...ev(at(0), "loops", "exercise", true, 0, "a"), concept: "telepathy" }, ...evidence("loops").map((e) => ({ ...e, lessonId: "next" }))];
    const m = model(stray);
    expect(m.quarantined.length).toBe(4);
    expect(m.concepts.has("telepathy")).toBe(false);
    expect(m.concepts.get("loops")!.status).toBe("new");
  });
});
