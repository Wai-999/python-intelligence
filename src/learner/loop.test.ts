import { describe, expect, it } from "vitest";
import type { ExerciseStep, Lesson } from "../content/types";
import type { PyError } from "../py/protocol";
import { buildModel, ordered, type LearnerEvent } from "./model";
import { boundNames, classifyError, codeOnly, logicalLines, statements, editDistance, interventionEvent, looksLikeTypo, LOOP_POLICY, MESO, mesoTrigger, transferTarget } from "./loop";
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
const failWith = (e: PyError, min: number, code = "") => exerciseEvents(L, E1, null, 0, at(min), classifyError(e, code));
const failCheck = (min: number) => exerciseEvents(L, E1, [{ concept: "loops", passed: false }], 0, at(min));
const pass = (step: ExerciseStep, min: number, help: 0 | 3 | 4 = 0) => exerciseEvents(L, step, [{ concept: step.tests[0]!.concept!, passed: true }], help, at(min));
const now = (min: number) => T0 + min * 60_000;

describe("classifying a failed run", () => {
  it("calls syntax errors and misspelt names slips, and other errors structural", () => {
    expect(classifyError(err("SyntaxError", "expected ':'"), "")).toEqual(["slip:syntax"]);
    expect(classifyError(err("IndentationError"), "")).toEqual(["slip:syntax"]);
    expect(classifyError(err("NameError", "name 'totl' is not defined"), "total = 0\nprint(totl)")).toEqual(["slip:name"]);
    expect(classifyError(err("NameError", "name 'Print' is not defined"), "Print(1)")).toEqual(["slip:name"]); // a built-in, wrong case
    expect(classifyError(err("NameError", "name 'TOTAL' is not defined"), "total = 1\nprint(TOTAL)")).toEqual(["slip:name"]); // case only
    // Not a near-miss of anything written: using a name that doesn't exist (yet) is structural.
    expect(classifyError(err("NameError", "name 'result' is not defined"), "def f():\n    result = 1\nprint(result)")).toEqual(["error:NameError"]);
    expect(classifyError(err("TypeError", "can only concatenate"), "")).toEqual(["error:TypeError"]);
    expect(classifyError(err("TimeoutError"), "")).toEqual(["error:TimeoutError"]);
  });

  it("measures near-misses by edit distance, stricter for short names", () => {
    expect(editDistance("totl", "total")).toBe(1);
    expect(editDistance("lenght", "length")).toBe(1); // a swap counts once
    expect(looksLikeTypo("lenght", "length = 3")).toBe(true);
    expect(looksLikeTypo("xy", "ab = 1")).toBe(false);
    expect(looksLikeTypo("ab", "xb = 1")).toBe(true); // distance 1 on a short name
    expect(looksLikeTypo("abcd", "xycd = 1")).toBe(false); // distance 2 is too far for a 4-letter name
    expect(looksLikeTypo("abcde", "xycde = 1")).toBe(true);
  });

  it("only counts names the code binds, never words in strings, comments or attribute names", () => {
    expect(codeOnly('x = "values" # the values\ny = \'it\\\'s\'\nz = """doc\nvalues"""')).not.toMatch(/values|doc|it/);
    const bound = boundNames("total, n = 0, 1\nfor i, item in enumerate(xs):\n    pass\ndef area(r, *rest, scale=2):\n    return r\nimport math as m\ncount += 1\nclass Box: pass\nif total == n: pass\n");
    for (const name of ["total", "n", "i", "item", "area", "r", "rest", "scale", "m", "count", "Box"]) expect(bound).toContain(name);
    for (const name of ["enumerate", "xs", "pass", "if", "math"]) expect(bound).not.toContain(name); // `import math as m` binds only m
    const names = (code: string) => [...boundNames(code)].sort();
    expect(names("total: int = 0\ncount: int\n")).toEqual(["count", "total"]); // annotated assignments
    expect(names("[first, second] = pair\n(a, (b, *c)) = x\np = q = 0\n")).toEqual(["a", "b", "c", "first", "p", "q", "second"]);
    expect(names("xs[i] = 1\nobj.attr = 2\ngrid[r][c] = 0\nd[k], e = 1, 2\n")).toEqual(["e"]); // subscriptions and attributes bind nothing
    expect(names("print(x, sep=y)\nif n == 1: pass\nwhile n >= 0: pass\n")).toEqual([]); // keyword arguments and comparisons aren't assignments
    // Several keyword arguments, alone or on an assignment's right-hand side, bind nothing but the target.
    expect(names("plot(xs, color=c, width=2, label=name)\nresult = dict(a=1, b=2, c=3)\nf(g(x=1), y=2)\n")).toEqual(["result"]);
    expect(names("def area(r, scale=1, unit='m'):\n    pass\n")).toEqual(["area", "r", "scale", "unit"]);
    // Lambda parameters, global/nonlocal declarations and comprehension targets (nested and starred).
    expect(names("square = lambda n, *more, k=2: n * k\n")).toEqual(["k", "more", "n", "square"]);
    expect(names("def f():\n    global total, count\n    nonlocal step\n")).toEqual(["count", "f", "step", "total"]);
    expect(names("pairs = [a + b for a, b in rows]\nflat = [x for (i, (j, *rest)) in grid for x in rest]\nsquares = {k: v * v for k, v in d.items()}\n"))
      .toEqual(["a", "b", "flat", "i", "j", "k", "pairs", "rest", "squares", "v", "x"]);
    expect(classifyError(err("NameError", "name 'labl' is not defined"), "plot(xs, color=c, label=name)\nprint(labl)")).toEqual(["error:NameError"]);
    expect(classifyError(err("NameError", "name 'totl' is not defined"), "def f():\n    global total\n    print(totl)")).toEqual(["slip:name"]);
    expect(classifyError(err("NameError", "name 'nmu' is not defined"), "sq = lambda num: nmu * num")).toEqual(["slip:name"]);
    expect(names("import os.path\nimport numpy as np, json\nfrom os import path as p, sep\nfrom m import (a, b)\nfrom n import *\n"))
      .toEqual(["a", "b", "json", "np", "os", "p", "sep"]);
    expect(names("with open(f) as fh, open(g) as gh:\n    pass\nexcept ValueError as err:\n    pass\nif (n := 10) > 5: pass\n"))
      .toEqual(["err", "fh", "gh", "n"]);
    // An annotated name's misspelling is a slip; an undefined subscript index or an aliased module's original name isn't.
    expect(classifyError(err("NameError", "name 'totl' is not defined"), "total: int = 0\nprint(totl)")).toEqual(["slip:name"]);
    expect(classifyError(err("NameError", "name 'indx' is not defined"), "xs = [0]\nxs[index] = 1\nprint(indx)")).toEqual(["error:NameError"]);
    expect(classifyError(err("NameError", "name 'mathh' is not defined"), "import math as m\nprint(mathh.pi)")).toEqual(["error:NameError"]);
    // "value" is undefined and its only look-alikes are in a comment, a string, an attribute and a call: structural.
    const code = '# add up the values\nprint("values")\ntotals = d.values()\nprint(value)';
    expect(classifyError(err("NameError", "name 'value' is not defined"), code)).toEqual(["error:NameError"]);
    expect(classifyError(err("NameError", "name 'value' is not defined"), "values = [1, 2]\nprint(value)")).toEqual(["slip:name"]);
    expect(looksLikeTypo("lenn", "print(lenn(xs))")).toBe(true); // a built-in, one edit away
    expect(looksLikeTypo("vale", "print(vale)")).toBe(false); // "vars" is two edits away: too far for a built-in
  });

  it("reads statements written over several lines as one", () => {
    expect(logicalLines("a = f(1,\n      2)\nb = 3\nc = 1 + \\\n    2\n")).toEqual(["a = f(1,       2)", "b = 3", "c = 1 +      2", ""]);
    const names = (code: string) => [...boundNames(code)].sort();
    expect(names("plot(xs,\n     color=c,\n     label=name)\n")).toEqual([]); // keyword arguments over several lines
    expect(names("result = dict(\n    a=1,\n    b=2,\n)\n")).toEqual(["result"]); // on an assignment's right-hand side
    expect(names("def area(width,\n         height=1,\n         *,\n         unit=(\"m\", 1)):\n    pass\n")).toEqual(["area", "height", "unit", "width"]);
    expect(names("total = first + \\\n    second\n")).toEqual(["total"]);
    expect(names("def scale(size=(1, 2), factor=3, *rest):\n    pass\n")).toEqual(["factor", "rest", "scale", "size"]); // after a parenthesised default
    expect(classifyError(err("NameError", "name 'labl' is not defined"), "plot(xs,\n     color=c,\n     label=name)\nprint(labl)")).toEqual(["error:NameError"]);
    // A misspelt parameter of a multi-line def is a slip, and repeating it never triggers a step back.
    const code = "def area(width,\n         height):\n    return wdith * height\n";
    const tags = classifyError(err("NameError", "name 'wdith' is not defined"), code);
    expect(tags).toEqual(["slip:name"]);
    const runs = [1, 2, 3, 4, 5].flatMap((m) => exerciseEvents(L, E1, null, 0, at(m), tags));
    expect(mesoTrigger(runs, "loops", now(30))).toBeNull();
  });

  it("blanks strings and comments in one pass, so quotes inside them start nothing", () => {
    const names = (code: string) => [...boundNames(code)].sort();
    expect(names("# don't use ''' here\ntotal = 0\n")).toEqual(["total"]); // a quote in a comment
    expect(names("s = \"'''\"\ntotal = 1\nt = '\"\"\"'\ncount = 2\n")).toEqual(["count", "s", "t", "total"]); // triple quotes inside strings
    expect(names("doc = \"\"\"first\nwidth = 3\n\"\"\"\nheight = 2\n")).toEqual(["doc", "height"]); // text inside a real triple-quoted string
    expect(names("msg = f\"{x}\" + rb'y'\n")).toEqual(["msg"]); // prefixes are part of the string
    expect(codeOnly("a = 'it\\'s'  # done\nb = 2")).toBe("a =                \nb = 2");
    expect(codeOnly("x = 'open\ny = 1")).toBe("x =      \ny = 1"); // an unterminated string ends at the line
    expect(classifyError(err("NameError", "name 'totl' is not defined"), "# don't use ''' here\ntotal = 0\nprint(totl)")).toEqual(["slip:name"]);
  });

  it("finds assignments after semicolons and in one-line suites", () => {
    expect(statements("if ready: total = 0; count = 1")).toEqual(["if ready:", "total = 0", "count = 1"]);
    expect(statements("for i in r: acc = i")).toEqual(["for i in r:", "acc = i"]);
    expect(statements("f = lambda x: x")).toEqual(["f = lambda x: x"]); // a lambda's colon isn't a suite
    expect(statements("if d == {1: 2}: hit = 1")).toEqual(["if d == {1: 2}:", "hit = 1"]);
    const names = (code: string) => [...boundNames(code)].sort();
    expect(names("total = 0; count = 1\n")).toEqual(["count", "total"]);
    expect(names("if ready: flag = 1\nelse: other = 2\nwhile n: step = n\ntry: value = 1\nexcept E as e: pass\nwith open(p) as fh: data = fh.read()\nclass C: size = 3\n"))
      .toEqual(["C", "data", "e", "fh", "flag", "other", "size", "step", "value"]);
    expect(names("for i in r: acc = i\ndef f(a): return a\n")).toEqual(["a", "acc", "f", "i"]);
    // Three runs of the same ordinary typo in these forms are slips, so no step back.
    for (const code of ["if ready: total = 0\nprint(totl)", "total = 0; count = 1\nprint(totl)", "# it's ''' odd\ntotal = 0\nprint(totl)"]) {
      const tags = classifyError(err("NameError", "name 'totl' is not defined"), code);
      expect(tags).toEqual(["slip:name"]);
      expect(mesoTrigger([1, 2, 3].flatMap((m) => exerciseEvents(L, E1, null, 0, at(m), tags)), "loops", now(10))).toBeNull();
    }
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
