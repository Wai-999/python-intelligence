/**
 * The double-loop part of the feedback controller (master prompt §6). The micro loop is the tutor note on every failed
 * run; this module decides when to step back (the meso loop): after repeated *structural* errors on a concept, or after
 * repeated reliance on strong hints. Slips (a syntax error, a misspelt name) are recorded but never trigger it, cooldowns
 * keep it from repeating, and every decision is logged with its policy version and the events that triggered it.
 * Pure functions, so the rules are testable without the browser.
 */
import { isExercise, type ExerciseStep, type Lesson } from "../content/types";
import type { PyError } from "../py/protocol";
import { ordered, SLIP_TAG_PREFIX, type LearnerEvent, type LearnerModel } from "./model";
import { creditedConcepts, type Stamp } from "./record";

export const LOOP_POLICY = "loop-1";
/** Starting hypotheses, not constants of nature (master prompt): ≥3 similar errors within 5 relevant attempts. */
export const MESO = { window: 5, similar: 3, strongHelp: 3, cooldownMs: 10 * 60_000 } as const;

// ---- Classifying a failed run -------------------------------------------------------------------------------------

const BUILTINS = ["print", "len", "range", "int", "str", "float", "bool", "list", "dict", "set", "tuple", "sum", "min", "max",
  "sorted", "reversed", "abs", "round", "input", "enumerate", "zip", "map", "filter", "isinstance", "type", "open", "True",
  "False", "None", "return", "while", "for", "def", "elif", "else", "import", "from", "lambda", "append", "items", "keys",
  "values", "split", "join", "strip", "lower", "upper", "format"];

/** Optimal string alignment distance (Levenshtein plus adjacent swaps). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
  }
  return d[a.length]![b.length]!;
}

/** True when an undefined name looks like a misspelling of a name the learner wrote (or a built-in). */
export function looksLikeTypo(name: string, code: string): boolean {
  const known = new Set([...(code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []), ...BUILTINS]);
  known.delete(name);
  const limit = name.length <= 4 ? 1 : 2;
  return [...known].some((k) => k.toLowerCase() === name.toLowerCase() || (k.length > 1 && editDistance(name, k) <= limit));
}

/**
 * Diagnostic tags for a failed run of the learner's code (never for an infrastructure failure, which records nothing).
 * "slip:syntax" / "slip:name" are surface slips; "error:<Type>" is a runtime error of another kind, including a NameError
 * that isn't a near-miss (using a name before it exists). Failed checks are tagged per concept by exerciseEvents.
 */
export function classifyError(error: PyError, code: string): string[] {
  if (error.type === "SyntaxError" || error.type === "IndentationError" || error.type === "TabError") return [`${SLIP_TAG_PREFIX}syntax`];
  if (error.type === "NameError") {
    const name = /name '([^']+)' is not defined/.exec(error.message)?.[1];
    if (name && looksLikeTypo(name, code)) return [`${SLIP_TAG_PREFIX}name`];
  }
  return [`error:${error.type}`];
}

// ---- The meso trigger ---------------------------------------------------------------------------------------------

export interface Intervention {
  kind: "counterexample" | "independence";
  concept: string;
  /** The repeated structural tag (e.g. "error:TypeError", "check:loops"), or "help:strong" for hint dependence. */
  signature: string;
  /** Ids of the attempts that triggered it. */
  supports: string[];
}

/**
 * The meso intervention for `concept`, if one is due at `nowMs`. The relevant decisions are those on this concept and
 * those on the task being worked on (`task`, "lessonId:stepId"): one attempt is credited to several concepts with the
 * same error tags, so a step back for one of them covers the others. Only attempts after the last relevant decision
 * count (so the same evidence never triggers twice), and none is offered within MESO.cooldownMs of it.
 */
export function mesoTrigger(events: readonly LearnerEvent[], concept: string, nowMs: number, task?: string): Intervention | null {
  const all = ordered(events);
  const lastDecision = all.filter((e) => e.task === "intervention" && (e.concept === concept || `${e.lessonId}:${e.stepId}` === task)).at(-1);
  const mine = all.filter((e) => e.concept === concept && e.task === "exercise");
  if (lastDecision && nowMs - Date.parse(lastDecision.at) < MESO.cooldownMs) return null;
  const since = lastDecision ? Date.parse(lastDecision.at) : -Infinity;
  const recent = mine.filter((e) => Date.parse(e.at) > since).slice(-MESO.window);

  const counts = new Map<string, LearnerEvent[]>();
  for (const e of recent) {
    if (e.passed) continue;
    for (const tag of new Set(e.tags ?? [])) {
      if (tag.startsWith(SLIP_TAG_PREFIX)) continue; // a repeated typo is not a misconception
      counts.set(tag, [...(counts.get(tag) ?? []), e]);
    }
  }
  const repeated = [...counts].filter(([, es]) => es.length >= MESO.similar)
    .sort((a, b) => b[1].length - a[1].length || Date.parse(b[1].at(-1)!.at) - Date.parse(a[1].at(-1)!.at));
  if (repeated.length > 0) {
    const [signature, es] = repeated[0]!;
    return { kind: "counterexample", concept, signature, supports: es.map((e) => e.id) };
  }
  const leaned = recent.filter((e) => e.passed && e.assistance >= MESO.strongHelp);
  if (leaned.length >= MESO.similar) return { kind: "independence", concept, signature: "help:strong", supports: leaned.map((e) => e.id) };
  return null;
}

/** Outcome of a shown intervention: shown, the learner worked through it, or postponed it ("Not now"). */
export type Outcome = "shown" | "answered" | "postponed";

/** The decision log entry for an intervention (never evidence of learning; the model skips it). */
export function interventionEvent(i: Intervention, lessonId: string, stepId: string, outcome: Outcome, stamp: Stamp): LearnerEvent {
  return { id: stamp.id(), at: stamp.at, lessonId, stepId, task: "intervention", concept: i.concept, passed: outcome === "answered",
    assistance: 0, policy: LOOP_POLICY, tags: ["loop:meso", `kind:${i.kind}`, `signature:${i.signature}`, `outcome:${outcome}`], supports: [...i.supports] };
}

// ---- The evidence check: an independent transfer task ------------------------------------------------------------

export interface Target { lessonId: string; stepIndex: number; title: string }

/**
 * A different exercise for the concept, not yet solved independently, to try without hints after an intervention:
 * the master prompt's "novel transfer task without hints". The current lesson first, then the others in order.
 */
export function transferTarget(lessons: readonly Lesson[], model: LearnerModel, concept: string, lessonId: string, stepId: string): Target | null {
  const solved = new Set(model.concepts.get(concept)?.independentTasks ?? []);
  const order = [...lessons].sort((a, b) => (a.id === lessonId ? -1 : b.id === lessonId ? 1 : 0));
  for (const l of order) {
    for (const [stepIndex, s] of l.steps.entries()) {
      if (!isExercise(s) || (l.id === lessonId && s.id === stepId) || solved.has(`${l.id}:${s.id}`)) continue;
      if (creditedConcepts(l, s as ExerciseStep).includes(concept)) return { lessonId: l.id, stepIndex, title: s.title };
    }
  }
  return null;
}
