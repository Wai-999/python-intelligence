import { describe, expect, it } from "vitest";
import { LESSONS } from "../content/lessons";
import { buildModel, ordered } from "../learner/model";
import { buildGraph, isUnlocked, recommendNext } from "./graph";
import { DIAGNOSTIC, diagnosticEvents, placement, type Answer, type Diagnostic } from "./placement";

const graph = buildGraph(LESSONS);
let n = 0;
const stamp = (at: string) => ({ at, id: () => `e${++n}` });
/** Answers for the first `k` checkpoints all right, then the next checkpoint with one wrong answer. */
const upTo = (d: Diagnostic, k: number, last: "wrong" | "unsure" | "none" = "wrong"): Record<string, Answer> => {
  const a: Record<string, Answer> = {};
  d.checkpoints.slice(0, k).forEach((c) => c.questions.forEach((q) => { a[q.id] = q.answer; }));
  const next = d.checkpoints[k];
  if (next && last !== "none") next.questions.forEach((q, i) => { a[q.id] = i === 0 ? (last === "unsure" ? null : (q.answer + 1) % q.choices.length) : q.answer; });
  return a;
};
const covers = (k: number) => new Set(DIAGNOSTIC.checkpoints.slice(0, k).flatMap((c) => c.covers));

describe("placement check", () => {
  it("is empty before the check is taken", () => {
    const p = placement(DIAGNOSTIC, []);
    expect(p.testedOut.size).toBe(0);
    expect(p.at).toBeNull();
  });

  it("tests out of the checkpoints passed in order and stops at the first one missed", () => {
    const evs = diagnosticEvents(DIAGNOSTIC, "r1", upTo(DIAGNOSTIC, 2), stamp("2026-11-14T10:00:00Z"));
    const p = placement(DIAGNOSTIC, evs);
    expect(p.testedOut).toEqual(covers(2));
    expect(p.passed).toEqual(["basics", "loops-text"]);
    expect(p.stoppedAt).toBe("collections");
    expect(p.at).toBe("2026-11-14T10:00:00Z");
  });

  it("counts 'not sure' and unreached questions as not known", () => {
    expect(placement(DIAGNOSTIC, diagnosticEvents(DIAGNOSTIC, "r", upTo(DIAGNOSTIC, 1, "unsure"), stamp("2026-11-14T10:00:00Z"))).testedOut).toEqual(covers(1));
    // Stopping before a checkpoint was answered: it isn't passed.
    expect(placement(DIAGNOSTIC, diagnosticEvents(DIAGNOSTIC, "r", upTo(DIAGNOSTIC, 1, "none"), stamp("2026-11-14T10:00:00Z"))).stoppedAt).toBe("loops-text");
    const unsure = diagnosticEvents(DIAGNOSTIC, "r", upTo(DIAGNOSTIC, 0, "unsure"), stamp("2026-11-14T10:00:00Z"));
    expect(unsure.find((e) => e.tags?.includes("unsure"))?.passed).toBe(false);
  });

  it("passes every checkpoint only with every answer right", () => {
    const p = placement(DIAGNOSTIC, diagnosticEvents(DIAGNOSTIC, "r", upTo(DIAGNOSTIC, DIAGNOSTIC.checkpoints.length), stamp("2026-11-14T10:00:00Z")));
    expect(p.stoppedAt).toBeNull();
    expect(p.testedOut).toEqual(covers(DIAGNOSTIC.checkpoints.length));
  });

  it("uses only the latest run: a retake replaces the placement, and old answers never fill gaps", () => {
    const first = diagnosticEvents(DIAGNOSTIC, "r1", upTo(DIAGNOSTIC, 4), stamp("2026-11-14T10:00:00Z"));
    // The retake stops at the first checkpoint, answered only partly.
    const second = diagnosticEvents(DIAGNOSTIC, "r2", { expr: DIAGNOSTIC.checkpoints[0]!.questions[0]!.answer }, stamp("2026-11-15T10:00:00Z"));
    const p = placement(DIAGNOSTIC, [...first, ...second]);
    expect(p.testedOut.size).toBe(0);
    expect(p.stoppedAt).toBe("basics");
    // Order in the log doesn't matter; time does.
    expect(placement(DIAGNOSTIC, [...second, ...first]).testedOut.size).toBe(0);
  });

  it("never over-credits a question answered twice in one run", () => {
    const right = diagnosticEvents(DIAGNOSTIC, "r", upTo(DIAGNOSTIC, 1, "none"), stamp("2026-11-14T10:00:00Z"));
    const q = DIAGNOSTIC.checkpoints[0]!.questions[0]!;
    const wrong = diagnosticEvents(DIAGNOSTIC, "r", { [q.id]: (q.answer + 1) % q.choices.length }, stamp("2026-11-14T10:00:00Z"));
    expect(placement(DIAGNOSTIC, [...right, ...wrong]).testedOut.size).toBe(0);
  });

  it("produces valid events that the learner model logs but never counts", () => {
    const evs = diagnosticEvents(DIAGNOSTIC, "r", upTo(DIAGNOSTIC, DIAGNOSTIC.checkpoints.length), stamp("2026-11-14T10:00:00Z"));
    expect(ordered(evs)).toHaveLength(evs.length); // the store's validation accepts them
    const m = buildModel(LESSONS, evs);
    for (const s of m.concepts.values()) {
      expect(s.evidence).toBe(0);
      expect(s.status).toBe("new");
    }
    expect(m.quarantined).toEqual([]);
  });

  it("unlocks what follows tested-out lessons and recommends the first lesson not tested out, without completing anything", () => {
    const p = placement(DIAGNOSTIC, diagnosticEvents(DIAGNOSTIC, "r", upTo(DIAGNOSTIC, 2), stamp("2026-11-14T10:00:00Z")));
    const none = new Map();
    expect(isUnlocked(graph, "py-lists", none)).toBe(false);
    expect(isUnlocked(graph, "py-lists", none, p.testedOut)).toBe(true);
    expect(recommendNext(graph, none, undefined, p.testedOut)).toEqual({ kind: "next", lessonId: "py-lists" });
    // Without the placement, the first lesson as before.
    expect(recommendNext(graph, none)).toEqual({ kind: "next", lessonId: "py-values-names" });
  });

  it("still offers to finish a tested-out lesson the learner has started", () => {
    const p = placement(DIAGNOSTIC, diagnosticEvents(DIAGNOSTIC, "r", upTo(DIAGNOSTIC, 2), stamp("2026-11-14T10:00:00Z")));
    const started = new Map([["py-loops", { lessonId: "py-loops", steps: {}, furthestStep: 2, completed: false, mastery: 0, struggles: {} }]]);
    expect(recommendNext(graph, started, undefined, p.testedOut)).toEqual({ kind: "continue", lessonId: "py-loops" });
  });

  it("ignores events that aren't placement answers", () => {
    const evs = diagnosticEvents(DIAGNOSTIC, "r", upTo(DIAGNOSTIC, 2), stamp("2026-11-14T10:00:00Z"));
    const bad = [{ ...evs[0]!, id: "x1", stepId: "diagnostic:nocolon" }, { ...evs[0]!, id: "x2", task: "quiz" as const }];
    expect(placement(DIAGNOSTIC, bad).at).toBeNull();
  });
});
