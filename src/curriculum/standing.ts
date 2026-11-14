/**
 * Master prompt §1.4 ("Why this lesson") and §10 (map states: completed-assisted, completed-independent, review-due).
 * Pure functions over the curriculum graph, the event log and the learner model.
 */
import { isGraded, type Lesson } from "../content/types";
import type { LearnerEvent } from "../learner/model";
import type { Graph } from "./graph";

/** What a lesson builds on (its prerequisites) and what it opens (lessons that list it as a prerequisite). */
export function whyThisLesson(g: Graph, lessonId: string): { buildsOn: string[]; opens: string[] } {
  const lesson = g.byId.get(lessonId);
  if (!lesson) return { buildsOn: [], opens: [] };
  const opens = g.order.filter((id) => g.byId.get(id)!.prerequisites.includes(lessonId));
  return { buildsOn: [...lesson.prerequisites], opens };
}

/**
 * How a completed lesson was completed:
 * - "independent": every graded step has a passing attempt made without any help;
 * - "assisted": some graded step was passed only with help (hints, the solution, or a quiz retaken after its answers
 *   were shown);
 * - "unknown": no step was passed only with help, but some step's record predates whole-step results (an older quiz
 *   attempt), so independence can't be shown. It is never reported as independent.
 */
export type Completion = "independent" | "assisted" | "unknown";

function stepPassedBy(group: LearnerEvent[]): boolean | null {
  // Any evidenced whole-step pass in the group counts (a group is one attempt when events carry attempt ids).
  if (group.some((e) => e.stepPassed === true)) return true;
  if (group.some((e) => e.stepPassed === false)) return false;
  // Older exercise attempts: the step passed when every concept it recorded passed (exerciseEvents' rule).
  if (group[0]!.task === "exercise") return group.every((e) => e.passed);
  return null; // an older quiz attempt: per-concept results can't tell whether the quiz's pass mark was met
}

export function completionOf(lesson: Lesson, events: readonly LearnerEvent[]): Completion {
  let unknown = false;
  for (const step of lesson.steps.filter(isGraded)) {
    const attempts = new Map<string, LearnerEvent[]>();
    for (const e of events) {
      if (e.lessonId !== lesson.id || e.stepId !== step.id || (e.task !== "exercise" && e.task !== "quiz")) continue;
      // One attempt per id; older events without one are grouped by time and help level, judged conservatively.
      const key = e.attempt !== undefined ? `id:${e.attempt}` : `t:${e.at}|${e.assistance}`;
      attempts.set(key, [...(attempts.get(key) ?? []), e]);
    }
    let independent = false;      // an evidenced unaided pass
    let maybeIndependent = false; // an older unaided attempt whose whole-step result is unknown
    let assisted = false;         // a pass, or a possible pass, made with help
    for (const group of attempts.values()) {
      const passed = stepPassedBy(group);
      const unaided = group.every((e) => e.assistance === 0);
      if (passed === false) continue;
      if (passed === true && unaided) independent = true;
      else if (passed === null && unaided) maybeIndependent = true;
      else assisted = true; // with help: it can only ever be an assisted pass
    }
    if (independent) continue;
    if (assisted && !maybeIndependent) return "assisted";
    unknown = true;
  }
  return unknown ? "unknown" : "independent";
}

/** Whether any concept the lesson teaches is due for review (the same due set the Review page counts). */
export function reviewDueFor(lesson: Lesson, dueConcepts: ReadonlySet<string>): boolean {
  return lesson.concepts.some((c) => dueConcepts.has(c));
}
