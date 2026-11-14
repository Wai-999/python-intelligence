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
  const flagged = group.find((e) => e.stepPassed !== undefined);
  if (flagged) return flagged.stepPassed!;
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
      const key = `${e.at}|${e.assistance}`;
      attempts.set(key, [...(attempts.get(key) ?? []), e]);
    }
    let independent = false;
    let assisted = false;
    let unclear = false;
    for (const group of attempts.values()) {
      const passed = stepPassedBy(group);
      if (passed === null) { unclear = true; continue; }
      if (!passed) continue;
      if (group[0]!.assistance === 0) independent = true;
      else assisted = true;
    }
    if (independent) continue;
    if (assisted && !unclear) return "assisted";
    unknown = true;
  }
  return unknown ? "unknown" : "independent";
}

/** Whether any concept the lesson teaches is due for review (the same due set the Review page counts). */
export function reviewDueFor(lesson: Lesson, dueConcepts: ReadonlySet<string>): boolean {
  return lesson.concepts.some((c) => dueConcepts.has(c));
}
