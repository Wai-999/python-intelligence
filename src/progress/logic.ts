import type { Lesson } from "../content/types";
import { computeMastery, emptyProgress, isComplete } from "../curriculum/mastery";
import type { LessonProgress } from "./types";

export interface Outcome {
  passed: boolean;
  score?: number;
  /** Concepts of the checks that failed on this attempt (for remediation). */
  failedConcepts?: string[];
  /** Count this as an attempt (exercises/quizzes) or just a visit (prose). */
  attempt: boolean;
}

/** Pure: returns the next LessonProgress after a step outcome. */
export function applyOutcome(lesson: Lesson, prev: LessonProgress | undefined, stepId: string,
                             o: Outcome, now = new Date().toISOString()): LessonProgress {
  const p: LessonProgress = structuredClone(prev ?? emptyProgress(lesson.id));
  const before = p.steps[stepId];
  const attempts = (before?.attempts ?? 0) + (o.attempt ? 1 : 0);
  // Once passed, a step stays passed; a later failed retry doesn't erase earned credit.
  const passed = (before?.passed ?? false) || o.passed;
  const score = o.score === undefined ? before?.score : Math.max(before?.score ?? 0, o.score);
  p.steps[stepId] = { passed, attempts, updatedAt: now, ...(score === undefined ? {} : { score }) };
  if (!o.passed) for (const c of o.failedConcepts ?? []) p.struggles[c] = (p.struggles[c] ?? 0) + 1;
  p.mastery = Math.min(1, Math.max(0, computeMastery(lesson, p)));
  if (!p.completed && isComplete(lesson, p)) {
    p.completed = true;
    p.completedAt = now;
  }
  return p;
}

export function visitStep(lesson: Lesson, prev: LessonProgress | undefined, stepIndex: number): LessonProgress {
  const p: LessonProgress = structuredClone(prev ?? emptyProgress(lesson.id));
  p.furthestStep = Math.max(p.furthestStep, Math.min(stepIndex, lesson.steps.length - 1));
  return p;
}
