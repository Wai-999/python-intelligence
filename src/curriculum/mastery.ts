import { isGraded, type Lesson } from "../content/types";
import type { LessonProgress, StepResult } from "../progress/types";

/**
 * Mastery in 0..1. Each exercise weighs 1, the quiz weighs 2 (it samples every concept).
 * A passed exercise earns 1.0 on the first try, losing 0.1 per extra attempt, floored at 0.5:
 * persistence still counts, but first-try fluency counts more. Quiz credit = its score.
 */
export function stepCredit(kind: string, r: StepResult | undefined): number {
  if (!r) return 0;
  if (kind === "quiz") return r.score ?? (r.passed ? 1 : 0);
  return r.passed ? Math.max(0.5, 1 - 0.1 * (r.attempts - 1)) : 0;
}

export function computeMastery(lesson: Lesson, p: Pick<LessonProgress, "steps">): number {
  let earned = 0;
  let total = 0;
  for (const s of lesson.steps) {
    if (!isGraded(s)) continue;
    const w = s.kind === "quiz" ? 2 : 1;
    total += w;
    earned += w * stepCredit(s.kind, p.steps[s.id]);
  }
  return total === 0 ? 1 : Math.round((earned / total) * 1000) / 1000;
}

/** A lesson is complete when every graded step is passed. */
export function isComplete(lesson: Lesson, p: Pick<LessonProgress, "steps">): boolean {
  return lesson.steps.filter(isGraded).every((s) => p.steps[s.id]?.passed);
}

export function emptyProgress(lessonId: string): LessonProgress {
  return { lessonId, steps: {}, furthestStep: 0, completed: false, mastery: 0, struggles: {} };
}
