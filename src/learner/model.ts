/**
 * Learner model ("digital twin"), master prompt §4–5. Every number here is a transparent HEURISTIC, not a calibrated
 * probability. The model is a pure, chronological fold over an append-only event log, so any state can be replayed.
 */
import type { Lesson } from "../content/types";

export const POLICY_VERSION = "learner-heuristic-1";
const DAY = 24 * 60 * 60 * 1000;
/** Days until the next delayed review, by review stage. A failed or assisted review resets the stage to 0. */
export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30] as const;
/** Two independent successes on different tasks, plus an explanation check, give the evidence part of the gate (§4). */
export const INDEPENDENT_NEEDED = 2;
/** Successful spaced reviews, after completion, before a concept counts as durably mastered. */
export const REVIEWS_FOR_MASTERY = 2;
export const START_HINT_TIER = 2;
/** Automatic restoration stops at tier 3; a full worked example (tier 4) needs the learner's explicit request. */
export const MAX_AUTO_HINT_TIER = 3;
/** A diagnostic tag must recur on this many failures before it is reported as a misconception (never from one slip). */
export const MISCONCEPTION_REPEATS = 2;

/** 0 = no help; 1–3 = that many hints seen; 4 = the worked solution was shown. */
export type Assistance = 0 | 1 | 2 | 3 | 4;
/** "exercise": a coding task; "quiz": an explanation check; "review": a delayed retrieval. */
export type Task = "exercise" | "quiz" | "review";
const TASKS: readonly Task[] = ["exercise", "quiz", "review"];

export interface LearnerEvent {
  id: string;
  at: string; // ISO-8601 with an explicit offset (Z or ±hh:mm)
  lessonId: string;
  stepId: string;
  task: Task;
  concept: string;
  passed: boolean;
  assistance: Assistance;
  policy: string;
  /** Optional diagnostic labels for this attempt (e.g. an error class); a tag counts as a misconception only when repeated. */
  tags?: string[];
  /** Optional self-rated confidence before the attempt, 1 (guessing) to 5 (certain). */
  confidence?: 1 | 2 | 3 | 4 | 5;
}

export class LearnerDataError extends Error {
  constructor(message: string) { super(message); this.name = "LearnerDataError"; }
}

export type Status = "new" | "learning" | "complete" | "mastered";

export interface ConceptState {
  concept: string;
  lessonId: string;
  /** Distinct tasks (lessonId:stepId) solved without any help. Repeating one task doesn't add evidence. */
  independentTasks: string[];
  assistedSuccesses: number;
  explanationChecked: boolean;
  failures: number;
  /** Failures since the last success (feeds the estimate's penalty). */
  recentFailures: number;
  lastSuccess: string | null;
  /** Share of successes that needed help (hints or the solution); null until there is a success. */
  hintDependency: number | null;
  /** Diagnostic tags seen on at least MISCONCEPTION_REPEATS failed attempts, most frequent first. */
  misconceptionTags: string[];
  /** Mean self-rated confidence (scaled to 0..1) minus the success rate on the same attempts; null without ratings.
   *  Positive = over-confident, negative = under-confident. */
  confidenceCalibration: number | null;
  /** Own evidence (independent tasks + explanation) is in place. */
  evidenceReady: boolean;
  /** When the full gate (evidence + every prerequisite complete) was first met; starts the review schedule. */
  completedAt: string | null;
  reviewStage: number;
  reviewDue: string | null;
  successfulReviews: number;
  durable: boolean;
  /** Suggested starting hint tier for the next task (0 = predict first … 3 = analogous pattern; 4 only on request). */
  hintTier: number;
  /** Heuristic 0..1 summary of the evidence above, for display only. */
  masteryEstimate: number;
  uncertainty: "high" | "medium" | "low";
  evidence: number;
  prerequisitesMet: boolean;
  status: Status;
}

export interface LearnerModel {
  concepts: Map<string, ConceptState>;
  /** Valid events that don't fit the curriculum (unknown concept, or a lesson that doesn't teach it): kept, never counted. */
  quarantined: LearnerEvent[];
}

interface Running {
  independent: Set<string>;
  assisted: number;
  explanation: boolean;
  failures: number;
  recentFailures: number;
  lastSuccess: string | null;
  completedAt: number | null;
  stage: number;
  due: number | null;
  reviews: number;
  durable: boolean;
  tier: number;
  streakOk: number;
  streakFail: number;
  /** Task kind of the current failure streak: only failures on the same kind of task are comparable (§4). */
  failKind: Task | null;
  evidence: number;
  successes: number;
  independentSuccesses: number;
  tagCounts: Map<string, number>;
  rated: number;
  ratedConfidence: number;
  ratedPassed: number;
}

const fresh = (): Running => ({ independent: new Set(), assisted: 0, explanation: false, failures: 0, recentFailures: 0,
  lastSuccess: null, completedAt: null, stage: 0, due: null, reviews: 0, durable: false, tier: START_HINT_TIER,
  streakOk: 0, streakFail: 0, failKind: null, evidence: 0, successes: 0, independentSuccesses: 0, tagCounts: new Map(), rated: 0, ratedConfidence: 0, ratedPassed: 0 });

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** Milliseconds since the epoch for an ISO-8601 timestamp with an explicit offset; throws otherwise (incl. 2026-02-30). */
export function parseTime(value: unknown, what = "timestamp"): number {
  const m = typeof value === "string" ? ISO.exec(value) : null;
  const [y, mo, d, h, mi, sec, oh, om] = (m ?? []).slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const valid = m !== null && mo! >= 1 && mo! <= 12 && d! >= 1 && d! <= new Date(Date.UTC(y!, mo!, 0)).getUTCDate()
    && h! <= 23 && mi! <= 59 && sec! <= 59 && oh! <= 14 && om! <= 59;
  const t = valid ? Date.parse(value as string) : NaN;
  if (!Number.isFinite(t)) throw new LearnerDataError(`${what} must be an ISO-8601 time with an offset, got ${JSON.stringify(value)}`);
  return t;
}

function validate(e: unknown, i: number): LearnerEvent {
  const bad = (m: string) => new LearnerDataError(`event ${i}: ${m}`);
  if (e === null || typeof e !== "object") throw bad("must be an object");
  const v = e as Record<string, unknown>;
  for (const k of ["id", "lessonId", "stepId", "concept", "policy"] as const)
    if (typeof v[k] !== "string" || (v[k] as string).length === 0) throw bad(`${k} must be a nonempty string`);
  if (!TASKS.includes(v.task as Task)) throw bad("task must be exercise, quiz or review");
  if (typeof v.passed !== "boolean") throw bad("passed must be a boolean");
  if (!Number.isInteger(v.assistance) || (v.assistance as number) < 0 || (v.assistance as number) > 4) throw bad("assistance must be 0..4");
  parseTime(v.at, `event ${i} at`);
  if (v.tags !== undefined && (!Array.isArray(v.tags) || !v.tags.every((x) => typeof x === "string" && x.length > 0)))
    throw bad("tags must be a list of nonempty strings");
  if (v.confidence !== undefined && !(Number.isInteger(v.confidence) && (v.confidence as number) >= 1 && (v.confidence as number) <= 5))
    throw bad("confidence must be 1..5");
  return v as unknown as LearnerEvent;
}

const same = (a: LearnerEvent, b: LearnerEvent) => JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

/** Validated, de-duplicated (identical repeats of an id), sorted by time then id. Conflicting payloads for one id throw. */
export function ordered(events: readonly unknown[]): LearnerEvent[] {
  const byId = new Map<string, LearnerEvent>();
  events.forEach((raw, i) => {
    const e = validate(raw, i);
    const seen = byId.get(e.id);
    if (seen && !same(seen, e)) throw new LearnerDataError(`event id ${e.id} is used for two different events`);
    byId.set(e.id, e);
  });
  return [...byId.values()].sort((a, b) => parseTime(a.at) - parseTime(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function observe(r: Running, e: LearnerEvent, t: number) {
  r.evidence += 1;
  const independent = e.passed && e.assistance === 0;
  // Hint fading: two independent successes in a row ease off one tier; two comparable failures in a row (the same kind
  // of task) restore one, up to tier 3. A failure on a different kind of task starts a new comparison.
  if (independent) { r.streakOk += 1; r.streakFail = 0; r.failKind = null; }
  else if (!e.passed) {
    r.streakOk = 0;
    r.streakFail = r.failKind === e.task ? r.streakFail + 1 : 1;
    r.failKind = e.task;
  }
  else { r.streakOk = 0; r.streakFail = 0; r.failKind = null; }
  if (r.streakOk >= 2) { r.tier = Math.max(0, r.tier - 1); r.streakOk = 0; }
  if (r.streakFail >= 2) { r.tier = Math.min(MAX_AUTO_HINT_TIER, r.tier + 1); r.streakFail = 0; }

  if (e.passed) { r.lastSuccess = e.at; r.recentFailures = 0; r.successes += 1; if (independent) r.independentSuccesses += 1; }
  else {
    r.failures += 1;
    r.recentFailures += 1;
    for (const tag of new Set(e.tags ?? [])) r.tagCounts.set(tag, (r.tagCounts.get(tag) ?? 0) + 1);
  }
  if (e.confidence !== undefined) { r.rated += 1; r.ratedConfidence += (e.confidence - 1) / 4; r.ratedPassed += e.passed ? 1 : 0; }

  if (e.task === "review" && r.completedAt !== null && r.due !== null) {
    // An early review passed without help is practice and doesn't move the schedule; an early lapse still counts.
    if (t < r.due && independent) return;
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
}

const ready = (r: Running) => r.independent.size >= INDEPENDENT_NEEDED && r.explanation;

/** Heuristic, labelled as such in the UI: evidence points minus a penalty for failures since the last success, in [0, 1]. */
function estimate(r: Running): number {
  const v = 0.25 * Math.min(INDEPENDENT_NEEDED, r.independent.size) + (r.explanation ? 0.2 : 0)
    + 0.05 * Math.min(2, r.assisted) + 0.1 * Math.min(REVIEWS_FOR_MASTERY, r.reviews) - 0.1 * Math.min(5, r.recentFailures);
  return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
}

export function buildModel(lessons: Lesson[], events: readonly unknown[]): LearnerModel {
  const owner = new Map<string, Lesson>();
  for (const l of lessons) for (const c of l.concepts) owner.set(c, l);
  const byId = new Map(lessons.map((l) => [l.id, l]));
  // Prerequisite concepts per concept; a missing prerequisite lesson can never be complete (fail closed).
  const missing = Symbol("missing");
  const prereqs = new Map<string, (string | typeof missing)[]>();
  for (const [c, l] of owner) prereqs.set(c, l.prerequisites.flatMap((id): (string | typeof missing)[] => byId.get(id)?.concepts ?? [missing]));

  const running = new Map<string, Running>([...owner.keys()].map((c) => [c, fresh()]));
  const quarantined: LearnerEvent[] = [];

  // Mark every concept whose full gate is met as complete at time t, repeating until nothing changes (so a chain of
  // prerequisites completes in one step). Its delayed retrieval is scheduled from that moment.
  const settle = (t: number) => {
    for (let changed = true; changed;) {
      changed = false;
      for (const [c, r] of running) {
        if (r.completedAt !== null || !ready(r)) continue;
        if (!prereqs.get(c)!.every((p) => p !== missing && running.get(p)!.completedAt !== null)) continue;
        r.completedAt = t;
        r.stage = 0;
        r.due = t + REVIEW_INTERVALS_DAYS[0] * DAY;
        changed = true;
      }
    }
  };
  for (const e of ordered(events)) {
    const lesson = owner.get(e.concept);
    if (!lesson || lesson.id !== e.lessonId) { quarantined.push(e); continue; }
    const t = parseTime(e.at);
    observe(running.get(e.concept)!, e, t);
    settle(t);
  }

  const concepts = new Map<string, ConceptState>();
  for (const [concept, r] of running) {
    const prerequisitesMet = prereqs.get(concept)!.every((p) => p !== missing && running.get(p)!.completedAt !== null);
    const status: Status = r.evidence === 0 ? "new" : r.completedAt === null ? "learning" : r.durable ? "mastered" : "complete";
    concepts.set(concept, {
      concept, lessonId: owner.get(concept)!.id, independentTasks: [...r.independent].sort(), assistedSuccesses: r.assisted,
      explanationChecked: r.explanation, failures: r.failures, recentFailures: r.recentFailures, lastSuccess: r.lastSuccess,
      hintDependency: r.successes === 0 ? null : Math.round(((r.successes - r.independentSuccesses) / r.successes) * 100) / 100,
      misconceptionTags: [...r.tagCounts].filter(([, k]) => k >= MISCONCEPTION_REPEATS).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([tag]) => tag),
      confidenceCalibration: r.rated === 0 ? null : Math.round(((r.ratedConfidence - r.ratedPassed) / r.rated) * 100) / 100,
      evidenceReady: ready(r), completedAt: r.completedAt === null ? null : new Date(r.completedAt).toISOString(),
      reviewStage: r.stage, reviewDue: r.due === null ? null : new Date(r.due).toISOString(), successfulReviews: r.reviews,
      durable: r.durable, hintTier: r.tier, masteryEstimate: estimate(r),
      uncertainty: r.evidence < 2 ? "high" : r.evidence < 5 ? "medium" : "low", evidence: r.evidence, prerequisitesMet, status,
    });
  }
  return { concepts, quarantined };
}

/** Concepts whose delayed review is due at `now`, most overdue first (ties by concept id). */
export function dueReviews(model: LearnerModel, now: string): ConceptState[] {
  const t = parseTime(now, "now");
  return [...model.concepts.values()]
    .filter((s) => s.reviewDue !== null && Date.parse(s.reviewDue) <= t)
    .sort((a, b) => Date.parse(a.reviewDue!) - Date.parse(b.reviewDue!) || (a.concept < b.concept ? -1 : 1));
}
