import { describe, expect, it } from "vitest";
import type { ExerciseStep, Lesson } from "../content/types";
import type { PyError } from "../py/protocol";
import { buildModel, ordered, type LearnerEvent } from "./model";
import { classifyError, editDistance, interventionEvent, looksLikeTypo, LOOP_POLICY, MESO, mesoTrigger, transferTarget } from "./loop";
import { exerciseEvents } from "./record";

const err = (type: string, message = ""): PyError => ({ type, message, line: 1, summary: `${type}: ${message}` });
const ex = (id: string, concepts: string[]): ExerciseStep =>
  ({ id, kind: "guided", title: `Task ${id}`, body: "", starter: "", hints: [], solution: "", tests: concepts.map((c, i) => ({ name: `t${i}`, code: "", concept: c })) }) as unknown as ExerciseStep;
const E1 = ex("e1", ["loops"]);
const E2 = ex("e2", ["loops"]);
const E3 = ex("e3", ["ranges"]);
const L = { id: "basics", title: "Basics", summary: "", track: "python", level: 1, estimated_minutes: 5, prerequisites: [], concepts: ["loops", "ranges"],
  sources: [], license: "", steps: [E1, E2, E3] } as unknown as Lesson;
const T0 = Date.parse("2026-02-01T09:00:00Z");
let k = 0;
const at = (min: number) => ({ at: new Date(T0 + min * 60_000).toISOString(), id: () => `ev${++k}` });
/** A failed run of E1 whose code raised `e` (classified as the app would). */
const nameErr = (name: string, bound: string[]): PyError => ({ ...err("NameError", `name '${name}' is not defined`), bound });
const failWith = (e: PyError, min: number) => exerciseEvents(L, E1, null, 0, at(min), classifyError(e));
const failCheck = (min: number) => exerciseEvents(L, E1, [{ concept: "loops", passed: false }], 0, at(min));
const pass = (step: ExerciseStep, min: number, help: 0 | 3 | 4 = 0) => exerciseEvents(L, step, [{ concept: step.tests[0]!.concept!, passed: true }], help, at(min));
const now = (min: number) => T0 + min * 60_000;

describe("classifying a failed run", () => {
  it("calls syntax errors and misspelt names slips, and other errors structural", () => {
    expect(classifyError(err("SyntaxError", "expected ':'"))).toEqual(["slip:syntax"]);
    expect(classifyError(err("IndentationError"))).toEqual(["slip:syntax"]);
    expect(classifyError(err("TabError"))).toEqual(["slip:syntax"]);
    expect(classifyError(nameErr("totl", ["total"]))).toEqual(["slip:name"]);
    expect(classifyError(nameErr("Print", []))).toEqual(["slip:name"]); // a built-in, wrong case
    expect(classifyError(nameErr("TOTAL", ["total"]))).toEqual(["slip:name"]); // case only, however long
    // Not a near-miss of anything the code binds: using a name that doesn't exist (yet) is structural.
    expect(classifyError(nameErr("result", ["f"]))).toEqual(["error:NameError"]);
    expect(classifyError(nameErr("value", []))).toEqual(["error:NameError"]);
    // Without the names (an older worker), only built-ins can make it a slip.
    expect(classifyError(err("NameError", "name 'totl' is not defined"))).toEqual(["error:NameError"]);
    expect(classifyError(err("NameError", "name 'lenn' is not defined"))).toEqual(["slip:name"]);
    expect(classifyError(err("UnboundLocalError", "cannot access local variable 'count'"))).toEqual(["error:UnboundLocalError"]);
    expect(classifyError(err("TypeError", "can only concatenate"))).toEqual(["error:TypeError"]);
    expect(classifyError(err("TimeoutError"))).toEqual(["error:TimeoutError"]);
  });

  it("never calls a bound name a typo of another: that is a scope or ordering error", () => {
    expect(classifyError(nameErr("total", ["total", "totals"]))).toEqual(["error:NameError"]); // bound in another function, say
    expect(classifyError(nameErr("lst", ["lst"]))).toEqual(["error:NameError"]); // even though it is one edit from the built-in list
    expect(classifyError(nameErr("totl", ["total"]))).toEqual(["slip:name"]);
  });

  it("classifies an error raised while a check ran the learner's code, per check", () => {
    const tags = classifyError(nameErr("wdith", ["area", "width"]));
    const [loops] = exerciseEvents(L, E1, [{ concept: "loops", passed: false, tags }], 0, at(0));
    expect(loops!.tags).toEqual(["slip:name"]); // not check:loops
    const runs = [1, 2, 3].flatMap((m) => exerciseEvents(L, E1, [{ concept: "loops", passed: false, tags }], 0, at(m)));
    expect(mesoTrigger(runs, "loops", now(10))).toBeNull(); // three test-invoked typos never trigger a step back
    const wrong = [1, 2, 3].flatMap((m) => exerciseEvents(L, E1, [{ concept: "loops", passed: false }], 0, at(m)));
    expect(mesoTrigger(wrong, "loops", now(10))).toMatchObject({ signature: "check:loops" }); // three wrong results do
  });

  it("measures near-misses by edit distance, stricter for short names and for built-ins", () => {
    expect(editDistance("totl", "total")).toBe(1);
    expect(editDistance("lenght", "length")).toBe(1); // a swap counts once
    expect(looksLikeTypo("lenght", ["length"])).toBe(true);
    expect(looksLikeTypo("xy", ["ab"])).toBe(false);
    expect(looksLikeTypo("ab", ["xb"])).toBe(true); // distance 1 on a short name
    expect(looksLikeTypo("abcd", ["xycd"])).toBe(false); // distance 2 is too far for a 4-letter name
    expect(looksLikeTypo("abcde", ["xycde"])).toBe(true);
    expect(looksLikeTypo("nn", ["n"])).toBe(false); // single letters are too easy to be near
    expect(looksLikeTypo("lenn", [])).toBe(true); // a built-in, one edit away
    expect(looksLikeTypo("vale", [])).toBe(false); // "vars" is two edits away: too far for a built-in
    expect(looksLikeTypo("total", ["total"])).toBe(false); // the same name isn't a near-miss of itself
  });

  it("treats a misspelt class-private name as a slip (both names arrive mangled)", () => {
    const tags = classifyError(nameErr("_Counter__totl", ["Counter", "_Counter__total", "bump", "self"]));
    expect(tags).toEqual(["slip:name"]);
    expect(mesoTrigger([1, 2, 3].flatMap((m) => exerciseEvents(L, E1, null, 0, at(m), tags)), "loops", now(10))).toBeNull();
  });

  it("never steps back for a misspelt name, however it was bound", () => {
    const tags = classifyError(nameErr("wdith", ["area", "height", "width"]));
    expect(tags).toEqual(["slip:name"]);
    expect(mesoTrigger([1, 2, 3, 4, 5].flatMap((m) => exerciseEvents(L, E1, null, 0, at(m), tags)), "loops", now(30))).toBeNull();
  });

  it("tags failed checks per concept on the events", () => {
    const [loops, ranges] = exerciseEvents({ ...L, steps: [ex("two", ["loops", "ranges"])] } as Lesson, ex("two", ["loops", "ranges"]),
      [{ concept: "loops", passed: false }, { concept: "ranges", passed: true }], 0, at(0));
    expect(loops!.tags).toEqual(["check:loops"]);
    expect(ranges!.tags).toBeUndefined(); // a passed concept carries no failure tags
    const ok = exerciseEvents(L, E1, [{ concept: "loops", passed: true }], 0, at(1), ["error:TypeError"]);
    expect(ok.every((e) => e.passed && e.tags === undefined)).toBe(true); // tags describe failures only
  });
});

describe("the meso trigger", () => {
  it("never steps back for a repeated typo, and the model doesn't call it a misconception", () => {
    const evs = [1, 2, 3, 4, 5].flatMap((m) => failWith(err("SyntaxError", "expected ':'"), m));
    expect(mesoTrigger(evs, "loops", now(30))).toBeNull();
    expect(buildModel([L], evs).concepts.get("loops")!.misconceptionTags).toEqual([]);
  });

  it("steps back after three similar structural errors within five attempts, naming the evidence", () => {
    const evs = [...failWith(err("TypeError"), 1), ...failCheck(2), ...failWith(err("TypeError"), 3)];
    expect(mesoTrigger(evs, "loops", now(4))).toBeNull(); // two is not a pattern
    const more = [...evs, ...failWith(err("TypeError"), 4)];
    const i = mesoTrigger(more, "loops", now(5))!;
    expect(i).toMatchObject({ kind: "counterexample", concept: "loops", signature: "error:TypeError" });
    expect(i.supports).toEqual(more.filter((e) => e.tags?.includes("error:TypeError")).map((e) => e.id));
    expect(buildModel([L], more).concepts.get("loops")!.misconceptionTags).toContain("error:TypeError");
  });

  it("counts only the last five attempts", () => {
    const evs = [...failWith(err("TypeError"), 1), ...failWith(err("TypeError"), 2), ...[3, 4, 5, 6].flatMap((m) => failCheck(m)), ...failWith(err("TypeError"), 7)];
    // TypeError appears three times overall but only once in the last five; the failed check appears four times there.
    expect(mesoTrigger(evs, "loops", now(8))).toMatchObject({ signature: "check:loops" });
    expect(mesoTrigger([...failWith(err("TypeError"), 1), ...failWith(err("TypeError"), 2), ...[3, 4, 5, 6, 7].flatMap((m) => pass(E1, m)),
      ...failWith(err("TypeError"), 8)], "loops", now(9))).toBeNull();
  });

  it("cools down: not again within ten minutes, and never from the same evidence", () => {
    const evs = [1, 2, 3].flatMap((m) => failWith(err("IndexError"), m));
    const i = mesoTrigger(evs, "loops", now(4))!;
    const shown = interventionEvent(i, L.id, E1.id, "shown", at(4));
    const later = [...evs, shown, ...[5, 6, 7].flatMap((m) => failWith(err("IndexError"), m))];
    expect(mesoTrigger(later, "loops", now(4 + MESO.cooldownMs / 60_000 - 1))).toBeNull(); // within the cooldown
    expect(mesoTrigger([...evs, shown], "loops", now(60))).toBeNull(); // only old evidence: nothing new to act on
    expect(mesoTrigger(later, "loops", now(60))).toMatchObject({ signature: "error:IndexError" }); // three new ones
    // A postponement counts as a decision too.
    const postponed = interventionEvent(i, L.id, E1.id, "postponed", at(5));
    expect(mesoTrigger([...evs, postponed, ...failWith(err("IndexError"), 6)], "loops", now(60))).toBeNull();
  });

  it("lets a step back on one task cover every concept that task is credited to", () => {
    const two = ex("two", ["loops", "ranges"]);
    const L2 = { ...L, steps: [two, E1, E3] } as unknown as Lesson;
    const evs = [1, 2, 3].flatMap((m) => exerciseEvents(L2, two, null, 0, at(m), ["error:TypeError"]));
    const i = mesoTrigger(evs, "loops", now(4), `${L2.id}:two`)!;
    const shown = interventionEvent(i, L2.id, "two", "shown", at(4));
    const again = [...evs, shown, ...[5, 6, 7].flatMap((m) => exerciseEvents(L2, two, null, 0, at(m), ["error:TypeError"]))];
    expect(mesoTrigger(again, "ranges", now(8), `${L2.id}:two`)).toBeNull(); // same task, within the cooldown
    expect(mesoTrigger(again, "ranges", now(8))).not.toBeNull(); // without the task, "ranges" would trigger from the same runs
  });

  it("steps back when the code works but explaining it keeps failing (an explanation mismatch)", () => {
    const answer = (passed: boolean, min: number, task: "quiz" | "review" = "quiz"): LearnerEvent =>
      ({ id: `q${min}-${++k}`, at: at(min).at, lessonId: L.id, stepId: "check", task, concept: "loops", passed, assistance: 0, policy: "learner-heuristic-1" });
    const coded = pass(E1, 1);
    const i = mesoTrigger([...coded, answer(false, 2), answer(false, 3, "review")], "loops", now(4))!;
    expect(i).toMatchObject({ kind: "explanation", signature: "explain:mismatch" });
    expect(i.supports).toEqual([coded[0]!.id, ...[2, 3].map((m) => expect.stringMatching(new RegExp(`^q${m}-`)))]);
    expect(mesoTrigger([...coded, answer(false, 2)], "loops", now(4))).toBeNull(); // one miss is not a pattern
    expect(mesoTrigger([answer(false, 2), answer(false, 3)], "loops", now(4))).toBeNull(); // no working code: a plain gap, not a mismatch
    expect(mesoTrigger([...pass(E1, 1, 3), answer(false, 2), answer(false, 3)], "loops", now(4))).toBeNull(); // the code needed strong help
    // Cooldown and fresh evidence apply as for the other kinds.
    const shown = interventionEvent(i, L.id, "check", "shown", at(4));
    expect(mesoTrigger([...coded, answer(false, 2), answer(false, 3), shown, answer(false, 5), answer(false, 6)], "loops", now(60))).toBeNull();
    expect(mesoTrigger([...coded, answer(false, 2), answer(false, 3), shown, ...pass(E2, 20), answer(false, 21), answer(false, 22)], "loops", now(60)))
      .toMatchObject({ kind: "explanation" });
  });

  it("counts explanation misses only since the last independent explanation success", () => {
    const answer = (passed: boolean, min: number, assistance: 0 | 4 = 0): LearnerEvent =>
      ({ id: `r${min}-${++k}`, at: at(min).at, lessonId: L.id, stepId: "check", task: "quiz", concept: "loops", passed, assistance, policy: "learner-heuristic-1" });
    const coded = pass(E1, 1);
    expect(mesoTrigger([...coded, answer(false, 2), answer(false, 3), answer(true, 4)], "loops", now(5))).toBeNull(); // recovered
    expect(mesoTrigger([...coded, answer(false, 2), answer(false, 3), answer(true, 4, 4)], "loops", now(5))).toMatchObject({ kind: "explanation" }); // an assisted pass doesn't count as recovery
    expect(mesoTrigger([...coded, answer(false, 2), answer(true, 3), answer(false, 4)], "loops", now(5))).toBeNull(); // one miss since the recovery
    const again = mesoTrigger([...coded, answer(false, 2), answer(true, 3), answer(false, 4), answer(false, 5), answer(false, 6)], "loops", now(7))!;
    expect(again).toMatchObject({ kind: "explanation" });
    expect(again.supports).toHaveLength(1 + 3); // the coding success and the three misses after the recovery
  });

  it("steps back after repeated reliance on strong hints, but not for light help", () => {
    expect(mesoTrigger([1, 2, 3].flatMap((m) => pass(E1, m, 3)), "loops", now(4))).toMatchObject({ kind: "independence", signature: "help:strong" });
    expect(mesoTrigger([...pass(E1, 1, 4), ...pass(E1, 2, 4), ...pass(E1, 3, 0)], "loops", now(4))).toBeNull();
  });

  it("logs decisions with the policy and evidence, and the model ignores them as evidence", () => {
    const evs = [1, 2, 3].flatMap((m) => failWith(err("KeyError"), m));
    const i = mesoTrigger(evs, "loops", now(4))!;
    const d = interventionEvent(i, L.id, E1.id, "answered", at(4));
    expect(d).toMatchObject({ task: "intervention", policy: LOOP_POLICY, passed: true, supports: i.supports,
      tags: ["loop:meso", "kind:counterexample", "signature:error:KeyError", "outcome:answered"] });
    const withDecision = buildModel([L], [...evs, d]).concepts.get("loops")!;
    const without = buildModel([L], evs).concepts.get("loops")!;
    expect(withDecision).toEqual(without);
    expect(buildModel([L], [...evs, d]).quarantined).toEqual([]);
    for (const supports of [[""], [3], "ev1"]) expect(() => ordered([{ ...d, supports }])).toThrow("supports");
  });
});

describe("the independent transfer check", () => {
  it("offers a different exercise on the concept that hasn't been solved independently or had help", () => {
    const model = buildModel([L], []);
    expect(transferTarget([L], model, "loops", L.id, E1.id, {})).toEqual({ lessonId: L.id, stepIndex: 1, title: "Task e2" });
    const solvedE2 = buildModel([L], pass(E2, 1) as LearnerEvent[]);
    expect(transferTarget([L], solvedE2, "loops", L.id, E1.id, {})).toBeNull();
    expect(transferTarget([L], model, "ranges", L.id, E3.id, {})).toBeNull(); // E3 is the only one on ranges
    // A task where hints (or the solution) were already shown can't give independent evidence any more.
    expect(transferTarget([L], model, "loops", L.id, E1.id, { [`${L.id}:e2`]: 1 })).toBeNull();
    expect(transferTarget([L], model, "loops", L.id, E1.id, { [`${L.id}:e2`]: 0, "other:e2": 4 })).toEqual({ lessonId: L.id, stepIndex: 1, title: "Task e2" });
  });
});
