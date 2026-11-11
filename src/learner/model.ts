/**
 * Learner model ("digital twin"), master prompt §4–5. Every number here is a transparent HEURISTIC, not a calibrated
 * probability. The model is a pure fold over an append-only event log, so any state can be replayed and audited.
 */
import type { Lesson } from "../content/types";

export const POLICY_VERSION = "learner-heuristic-1";
const DAY = 24 * 60 * 60 * 1000;
/** Days until the next delayed review, by review stage. A failed review resets the stage to 0. */
export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30] as const;
/** Two independent successes on different tasks, plus an explanation check, open the gate (§4). */
export const INDEPENDENT_NEEDED = 2;
/** Successful spaced reviews needed before a concept counts as durably mastered (1 day, then 3 days later). */
export const REVIEWS_FOR_MASTERY = 2;
export const START_HINT_TIER = 2;

/** 0 = no help; 1–3 = that many hints seen; 4 = the worked solution was shown. */
export type Assistance = 0 | 1 | 2 | 3 | 4;
/** "exercise": a coding task; "quiz": an explanation check; "review": a delayed retrieval. */
export type Task = "exercise" | "quiz" | "review";

export interface LearnerEvent {
  id: string;
  at: string; // ISO-8601
  lessonId: string;
  stepId: string;
  task: Task;
  concept: string;
  passed: boolean;
  assistance: Assistance;
  policy: string;
}

export type Status = "new" | "learning" | "complete" | "mastered";

export interface ConceptState {
  concept: string;
  lessonId: string | null;
  /** Distinct tasks (lessonId:stepId) solved without any help. Repeating one task doesn't add evidence. */
  independentTasks: string[];
  assistedSuccesses: number;
  explanationChecked: boolean;
  failures: number;
  lastSuccess: string | null;
  /** When the evidence gate (independent tasks + explanation) was first met; starts the review schedule. */
  gateMetAt: string | null;
  reviewStage: number;
  reviewDue: string | null;
  successfulReviews: number;
  durable: boolean;
  /** Suggested starting hint tier for the next task on this concept (0 = predict first, 4 = worked example). */
  hintTier: number;
  /** Heuristic 0..1 summary of the evidence above, for display only. */
  masteryEstimate: number;
  uncertainty: "high" | "medium" | "low";
  evidence: number;
  prerequisitesMet: boolean;
  status: Status;
}

interface Running {
  independent: Set<string>;
  assisted: number;
  explanation: boolean;
  failures: number;
  lastSuccess: string | null;
  gateMetAt: string | null;
  stage: number;
  due: number | null;
  reviews: number;
  durable: boolean;
  tier: number;
  streakOk: number;
  streakFail: number;
  evidence: number;
}

const fresh = (): Running => ({ independent: new Set(), assisted: 0, explanation: false, failures: 0, lastSuccess: null,
  gateMetAt: null, stage: 0, due: null, reviews: 0, durable: false, tier: START_HINT_TIER, streakOk: 0, streakFail: 0, evidence: 0 });

function apply(r: Running, e: LearnerEvent) {
  const t = Date.parse(e.at);
  r.evidence += 1;
  const independent = e.passed && e.assistance === 0;
  // Hint fading: two independent successes in a row ease off one tier; two failures in a row restore one.
  if (independent) { r.streakOk += 1; r.streakFail = 0; }
  else if (!e.passed) { r.streakFail += 1; r.streakOk = 0; }
  else { r.streakOk = 0; r.streakFail = 0; }
  if (r.streakOk >= 2) { r.tier = Math.max(0, r.tier - 1); r.streakOk = 0; }
  if (r.streakFail >= 2) { r.tier = Math.min(4, r.tier + 1); r.streakFail = 0; }

  if (e.passed) r.lastSuccess = e.at;
  else r.failures += 1;

  if (e.task === "review" && r.gateMetAt !== null && r.due !== null) {
    if (t < r.due) return; // an early review is practice: it doesn't move the schedule
    if (independent) {
      r.reviews += 1;
      if (r.reviews >= REVIEWS_FOR_MASTERY) r.durable = true;
      r.stage = Math.min(r.stage + 1, REVIEW_INTERVALS_DAYS.length - 1);
      r.due = t + REVIEW_INTERVALS_DAYS[r.stage]! * DAY;
    } else {
      // Forgotten (or only recalled with help): start the spacing again and lose durable mastery.
      r.stage = 0;
      r.reviews = 0;
      r.durable = false;
      r.due = t + REVIEW_INTERVALS_DAYS[0] * DAY;
    }
    return;
  }
  if (e.passed && e.task === "quiz") r.explanation = true;
  else if (independent) r.independent.add(`${e.lessonId}:${e.stepId}`);
  else if (e.passed) r.assisted += 1;
  if (r.gateMetAt === null && r.independent.size >= INDEPENDENT_NEEDED && r.explanation) {
    r.gateMetAt = e.at;
    r.stage = 0;
    r.due = t + REVIEW_INTERVALS_DAYS[0] * DAY;
  }
}

/** Heuristic, labelled as such in the UI: evidence points, capped at 1. */
function estimate(r: Running): number {
  const v = 0.25 * Math.min(INDEPENDENT_NEEDED, r.independent.size) + (r.explanation ? 0.2 : 0)
    + 0.05 * Math.min(2, r.assisted) + 0.1 * Math.min(REVIEWS_FOR_MASTERY, r.reviews) - 0.1 * r.streakFail;
  return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
}

/** Sorted by time, then id, so replays are deterministic whatever order events were stored in. */
export function ordered(events: LearnerEvent[]): LearnerEvent[] {
  return [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function buildModel(lessons: Lesson[], events: LearnerEvent[]): Map<string, ConceptState> {
  const owner = new Map<string, Lesson>();
  for (const l of lessons) for (const c of l.concepts) owner.set(c, l);
  const running = new Map<string, Running>();
  for (const c of owner.keys()) running.set(c, fresh());
  for (const e of ordered(events)) {
    if (!running.has(e.concept)) running.set(e.concept, fresh());
    apply(running.get(e.concept)!, e);
  }
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const gate = (c: string) => running.get(c)?.gateMetAt != null;
  const out = new Map<string, ConceptState>();
  for (const [concept, r] of running) {
    const lesson = owner.get(concept) ?? null;
    const prereqConcepts = (lesson?.prerequisites ?? []).flatMap((id) => byId.get(id)?.concepts ?? []);
    const prerequisitesMet = prereqConcepts.every(gate);
    const complete = r.gateMetAt !== null && prerequisitesMet;
    const status: Status = r.evidence === 0 ? "new" : !complete ? "learning" : r.durable ? "mastered" : "complete";
    out.set(concept, {
      concept, lessonId: lesson?.id ?? null, independentTasks: [...r.independent].sort(), assistedSuccesses: r.assisted,
      explanationChecked: r.explanation, failures: r.failures, lastSuccess: r.lastSuccess, gateMetAt: r.gateMetAt,
      reviewStage: r.stage, reviewDue: r.due === null ? null : new Date(r.due).toISOString(), successfulReviews: r.reviews,
      durable: r.durable, hintTier: r.tier, masteryEstimate: estimate(r),
      uncertainty: r.evidence < 2 ? "high" : r.evidence < 5 ? "medium" : "low", evidence: r.evidence, prerequisitesMet, status,
    });
  }
  return out;
}

/** Concepts whose delayed review is due at `now`, most overdue first (ties by concept id). */
export function dueReviews(model: Map<string, ConceptState>, now: string): ConceptState[] {
  const t = Date.parse(now);
  return [...model.values()]
    .filter((s) => s.reviewDue !== null && Date.parse(s.reviewDue) <= t)
    .sort((a, b) => Date.parse(a.reviewDue!) - Date.parse(b.reviewDue!) || (a.concept < b.concept ? -1 : 1));
}
