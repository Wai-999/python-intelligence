/**
 * Placement check (diagnostic). Answers are logged as learner events with task "diagnostic"; the learner model never
 * counts them as evidence of mastery. Passing a checkpoint "tests out" of its lessons: they unlock what follows them and
 * the recommendation skips them, but they are never marked complete. Only the most recent run counts, so retaking the
 * check replaces the previous placement.
 */
import data from "../../content/diagnostic.json";
import type { LearnerEvent } from "../learner/model";
import type { Stamp } from "../learner/record";

export const PLACEMENT_POLICY = "placement-1";
/** stepId of a diagnostic answer: `${DIAGNOSTIC_PREFIX}${runId}:${questionId}`. */
export const DIAGNOSTIC_PREFIX = "diagnostic:";

export interface DiagnosticQuestion {
  id: string;
  lesson: string;
  concept: string;
  prompt: string;
  code?: string;
  /** The content gate runs `code` and checks that the marked choice is exactly its output. */
  output?: boolean;
  choices: string[];
  answer: number;
  explanation: string;
}

export interface Checkpoint {
  id: string;
  title: string;
  /** Lessons a learner tests out of by answering every question correctly (prerequisite-closed, checked by the gate). */
  covers: string[];
  questions: DiagnosticQuestion[];
}

export interface Diagnostic {
  version: number;
  checkpoints: Checkpoint[];
}

export const DIAGNOSTIC: Diagnostic = { version: data.version, checkpoints: data.checkpoints as Checkpoint[] };

/** The answer chosen for a question; null means "not sure" (counted as not known). */
export type Answer = number | null;

/** One event per answered question of a run, all with the run's time. */
export function diagnosticEvents(d: Diagnostic, runId: string, answers: Record<string, Answer>, stamp: Stamp): LearnerEvent[] {
  const out: LearnerEvent[] = [];
  for (const cp of d.checkpoints)
    for (const q of cp.questions) {
      if (!(q.id in answers)) continue;
      const a = answers[q.id];
      out.push({ id: stamp.id(), at: stamp.at, lessonId: q.lesson, stepId: `${DIAGNOSTIC_PREFIX}${runId}:${q.id}`, task: "diagnostic",
        concept: q.concept, passed: a === q.answer, assistance: 0, policy: PLACEMENT_POLICY, ...(a === null ? { tags: ["unsure"] } : {}) });
    }
  return out;
}

export interface Placement {
  /** Lessons tested out of in the latest run. */
  testedOut: Set<string>;
  /** Checkpoints passed, in order. */
  passed: string[];
  /** The checkpoint where the latest run stopped (null if every checkpoint was passed). */
  stoppedAt: string | null;
  /** When the latest run was recorded (null if the check was never taken). */
  at: string | null;
}

const NONE: Placement = { testedOut: new Set(), passed: [], stoppedAt: null, at: null };

/**
 * Placement from the latest run in the log (latest time, then the larger run id). Checkpoints are walked in order and
 * the walk stops at the first one with any question not answered correctly in that run, including questions the run
 * didn't reach and questions it doesn't know (an answer from an older run never counts).
 */
export function placement(d: Diagnostic, events: readonly LearnerEvent[]): Placement {
  const runs = new Map<string, { at: number; iso: string; answers: Map<string, boolean> }>();
  for (const e of events) {
    if (e.task !== "diagnostic" || !e.stepId.startsWith(DIAGNOSTIC_PREFIX)) continue;
    const rest = e.stepId.slice(DIAGNOSTIC_PREFIX.length);
    const cut = rest.lastIndexOf(":");
    if (cut <= 0) continue;
    const run = rest.slice(0, cut);
    const t = Date.parse(e.at);
    const r = runs.get(run) ?? { at: t, iso: e.at, answers: new Map() };
    if (t > r.at) { r.at = t; r.iso = e.at; }
    // Within one run a question is answered once; should it appear twice, a wrong answer wins (never over-credit).
    const qid = rest.slice(cut + 1);
    r.answers.set(qid, (r.answers.get(qid) ?? true) && e.passed);
    runs.set(run, r);
  }
  let latest: [string, { at: number; iso: string; answers: Map<string, boolean> }] | null = null;
  for (const entry of runs) if (!latest || entry[1].at > latest[1].at || (entry[1].at === latest[1].at && entry[0] > latest[0])) latest = entry;
  if (!latest) return NONE;
  const answers = latest[1].answers;
  const testedOut = new Set<string>();
  const passed: string[] = [];
  for (const cp of d.checkpoints) {
    if (cp.questions.length === 0 || !cp.questions.every((q) => answers.get(q.id) === true))
      return { testedOut, passed, stoppedAt: cp.id, at: latest[1].iso };
    passed.push(cp.id);
    for (const id of cp.covers) testedOut.add(id);
  }
  return { testedOut, passed, stoppedAt: null, at: latest[1].iso };
}
