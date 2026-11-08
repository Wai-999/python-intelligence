import type { Lesson } from "../content/types";
import type { LessonProgress } from "../progress/types";

export interface Graph {
  /** Topological order; ties broken by (track order, level, id) so the path is deterministic. */
  order: string[];
  byId: Map<string, Lesson>;
  /** concept id -> lesson that teaches it */
  teaches: Map<string, string>;
}

const TRACKS: Lesson["track"][] = ["python-core", "data", "statistics", "ml", "projects"];

export function validateGraph(lessons: Lesson[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const l of lessons) {
    if (ids.has(l.id)) errors.push(`duplicate lesson id ${l.id}`);
    ids.add(l.id);
  }
  for (const l of lessons)
    for (const p of l.prerequisites)
      if (!ids.has(p)) errors.push(`${l.id}: unknown prerequisite ${p}`);
      else if (p === l.id) errors.push(`${l.id}: lists itself as a prerequisite`);
  const owner = new Map<string, string>();
  for (const l of lessons)
    for (const c of l.concepts) {
      const prev = owner.get(c);
      if (prev) errors.push(`concept ${c} taught by both ${prev} and ${l.id}`);
      else owner.set(c, l.id);
    }
  if (errors.length === 0 && topo(lessons).length !== lessons.length) errors.push("prerequisite cycle detected");
  return errors;
}

function rank(l: Lesson): [number, number, string] {
  return [TRACKS.indexOf(l.track), l.level, l.id];
}

/** Among ready lessons: track order, then level, then continue the most recent chain, then id. */
function cmp(a: Lesson, b: Lesson, recency: (l: Lesson) => number = () => 0): number {
  const [x, y] = [rank(a), rank(b)];
  return x[0] - y[0] || x[1] - y[1] || recency(b) - recency(a) || x[2].localeCompare(y[2]);
}

function topo(lessons: Lesson[]): string[] {
  const indeg = new Map(lessons.map((l) => [l.id, l.prerequisites.length]));
  const kids = new Map<string, Lesson[]>(lessons.map((l) => [l.id, []]));
  for (const l of lessons) for (const p of l.prerequisites) kids.get(p)?.push(l);
  const out: string[] = [];
  const placed = new Map<string, number>();
  // Position of the most recently placed prerequisite: keeps a chain together (loops -> strings -> lists).
  const recency = (l: Lesson) => Math.max(-1, ...l.prerequisites.map((p) => placed.get(p) ?? -1));
  const byRank = (a: Lesson, b: Lesson) => cmp(a, b, recency);
  const ready = lessons.filter((l) => l.prerequisites.length === 0).sort(byRank);
  while (ready.length) {
    const l = ready.shift()!;
    placed.set(l.id, out.length);
    out.push(l.id);
    for (const k of kids.get(l.id) ?? []) {
      const n = (indeg.get(k.id) ?? 0) - 1;
      indeg.set(k.id, n);
      if (n === 0) {
        ready.push(k);
        ready.sort(byRank);
      }
    }
  }
  return out;
}

export function buildGraph(lessons: Lesson[]): Graph {
  const errors = validateGraph(lessons);
  if (errors.length) throw new Error(`invalid curriculum graph:\n${errors.join("\n")}`);
  const teaches = new Map<string, string>();
  for (const l of lessons) for (const c of l.concepts) teaches.set(c, l.id);
  return { order: topo(lessons), byId: new Map(lessons.map((l) => [l.id, l])), teaches };
}

export type ProgressMap = Map<string, LessonProgress>;

export function isUnlocked(g: Graph, id: string, progress: ProgressMap): boolean {
  const l = g.byId.get(id);
  return !!l && l.prerequisites.every((p) => progress.get(p)?.completed);
}

export type Recommendation =
  | { kind: "remediate"; lessonId: string; concept: string; because: string }
  | { kind: "continue"; lessonId: string }
  | { kind: "next"; lessonId: string }
  | { kind: "done" };

/** Concepts the learner has failed this many times trigger a prerequisite review. */
export const STRUGGLE_THRESHOLD = 3;
/** ...unless the lesson teaching that concept was already mastered at least this well. */
export const REMEDIATION_MASTERY = 0.8;

export function recommendNext(g: Graph, progress: ProgressMap, currentId?: string): Recommendation {
  // 1. Remediation: repeated failures on a concept taught by an earlier lesson that wasn't mastered.
  const focus = currentId ? [currentId] : g.order;
  for (const id of focus) {
    const p = progress.get(id);
    if (!p || p.completed) continue;
    const worst = Object.entries(p.struggles).sort((a, b) => b[1] - a[1]);
    for (const [concept, n] of worst) {
      if (n < STRUGGLE_THRESHOLD) break;
      const teacher = g.teaches.get(concept);
      if (teacher && teacher !== id && (progress.get(teacher)?.mastery ?? 0) < REMEDIATION_MASTERY)
        return { kind: "remediate", lessonId: teacher, concept, because: id };
    }
  }
  // 2. Finish what was started (in curriculum order).
  for (const id of g.order) {
    const p = progress.get(id);
    if (p && !p.completed && p.furthestStep > 0 && isUnlocked(g, id, progress)) return { kind: "continue", lessonId: id };
  }
  // 3. First unlocked, uncompleted lesson.
  for (const id of g.order)
    if (!progress.get(id)?.completed && isUnlocked(g, id, progress)) return { kind: "next", lessonId: id };
  return { kind: "done" };
}
