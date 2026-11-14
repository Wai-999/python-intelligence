import type { Graph, ProgressMap, Recommendation } from "../curriculum/graph";
import { isUnlocked } from "../curriculum/graph";
import { Recommend } from "./LessonView";
import { TRACK_LABEL, TRACK_ORDER } from "../curriculum/tracks";
import type { Completion } from "../curriculum/standing";

interface Props {
  graph: Graph;
  progress: ProgressMap;
  recommendation: Recommendation;
  currentId?: string;
  go: (lessonId: string, step: number) => void;
  compact?: boolean;
  /** Lessons tested out of in the placement check: reachable, but not complete. */
  testedOut?: ReadonlySet<string>;
  /** How a completed lesson was completed, and whether a review is due (§10). */
  standing?: (lessonId: string) => { completion: Completion | null; reviewDue: boolean };
  /** Another action on the page leads (a first visit's "Find your starting point"), so the recommendation is secondary. */
  recommendSecondary?: boolean;
}

const DONE_TEXT: Record<Completion, string> = { independent: "Completed independently", assisted: "Completed with help", unknown: "Completed" };

export function CurriculumMap({ graph, progress, recommendation, currentId, go, compact, testedOut = new Set(), standing, recommendSecondary = false }: Props) {
  const titleOf = (id: string) => graph.byId.get(id)?.title ?? id;
  const index = new Map(graph.order.map((id, n) => [id, n]));
  const isLocked = (id: string) => !progress.get(id)?.completed && !testedOut.has(id) && !isUnlocked(graph, id, progress, testedOut);
  // Lessons grouped by track, in curriculum order; the rail (compact) shows only the current lesson's track.
  const currentTrack = currentId ? graph.byId.get(currentId)?.track : undefined;
  const groups = TRACK_ORDER.map((track) => ({ track, ids: graph.order.filter((id) => graph.byId.get(id)!.track === track) }))
    .filter((g) => g.ids.length > 0 && (!compact || !currentTrack || g.track === currentTrack));
  const item = (id: string) => {
    const n = index.get(id)!;
          const l = graph.byId.get(id)!;
          const p = progress.get(id);
          const unlocked = isUnlocked(graph, id, progress, testedOut);
          const state = p?.completed ? "done" : p && p.furthestStep > 0 && unlocked ? "started" : testedOut.has(id) ? "tested" : !unlocked ? "locked" : "open";
          const resume = p && !p.completed ? Math.min(p.furthestStep, l.steps.length - 1) : 0;
          const st = standing?.(id);
          const text = { done: DONE_TEXT[st?.completion ?? "unknown"], locked: "Locked", started: "In progress", open: "Ready", tested: "Tested out" }[state]
            + (st?.reviewDue ? ", review due" : "");
          return (
            <li key={id} className={`map-item ${state} ${id === currentId ? "current" : ""} ${st?.reviewDue ? "due" : ""}`}>
              <span className="map-badge" aria-hidden="true">{state === "done" ? "✓" : state === "locked" ? "🔒" : state === "tested" ? "↷" : n + 1}</span>
              <div className="map-body">
                {state === "locked" ? (
                  <span className="map-link" aria-disabled="true">{l.title}</span>
                ) : (
                  <a className="map-link" href={`#/lesson/${id}/${resume}`} aria-current={id === currentId ? "page" : undefined}>{l.title}</a>
                )}
                <span className="sr-only">: {text}</span>
                {!compact && <p className="map-sum">{l.summary}</p>}
                <p className="map-meta">
                  {text} · {l.estimated_minutes} min
                  {p && p.mastery > 0 && <> · mastery {Math.round(p.mastery * 100)}%</>}
                  {state === "locked" && <> · needs {l.prerequisites.map(titleOf).join(", ")}</>}
                </p>
              </div>
            </li>
          );
  };
  return (
    <nav className={`map ${compact ? "compact" : ""}`} aria-label="Curriculum">
      {!compact && <Recommend r={recommendation} titleOf={titleOf} go={go} secondary={recommendSecondary} />}
      {groups.map((g) => {
        const visible = g.ids.filter((id) => !isLocked(id));
        const locked = g.ids.filter(isLocked);
        const done = g.ids.filter((id) => progress.get(id)?.completed).length;
        return (
          <section key={g.track} className="track" aria-labelledby={`track-${g.track}`}>
            <h2 className="map-title" id={`track-${g.track}`}>{TRACK_LABEL[g.track]} <span className="track-count">· {done} of {g.ids.length} done</span></h2>
            {visible.length > 0 && <ol className="map-list">{visible.map(item)}</ol>}
            {locked.length > 0 && (
              <details className="locked-group">
                <summary>{visible.length ? "and " : ""}{locked.length} locked lesson{locked.length === 1 ? "" : "s"}</summary>
                <ol className="map-list">{locked.map(item)}</ol>
              </details>
            )}
          </section>
        );
      })}
      {compact && <p className="full-map"><a href="#/">Full course map</a></p>}
    </nav>
  );
}
