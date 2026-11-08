import type { Graph, ProgressMap, Recommendation } from "../curriculum/graph";
import { isUnlocked } from "../curriculum/graph";
import { Recommend } from "./LessonView";

interface Props {
  graph: Graph;
  progress: ProgressMap;
  recommendation: Recommendation;
  currentId?: string;
  go: (lessonId: string, step: number) => void;
  compact?: boolean;
}

export function CurriculumMap({ graph, progress, recommendation, currentId, go, compact }: Props) {
  const titleOf = (id: string) => graph.byId.get(id)?.title ?? id;
  return (
    <nav className={`map ${compact ? "compact" : ""}`} aria-label="Curriculum">
      {!compact && <Recommend r={recommendation} titleOf={titleOf} go={go} />}
      <h2 className="map-title">Python fundamentals</h2>
      <ol className="map-list">
        {graph.order.map((id, n) => {
          const l = graph.byId.get(id)!;
          const p = progress.get(id);
          const unlocked = isUnlocked(graph, id, progress);
          const state = p?.completed ? "done" : !unlocked ? "locked" : p && p.furthestStep > 0 ? "started" : "open";
          const resume = p && !p.completed ? Math.min(p.furthestStep, l.steps.length - 1) : 0;
          const text = { done: "Completed", locked: "Locked", started: "In progress", open: "Ready" }[state];
          return (
            <li key={id} className={`map-item ${state} ${id === currentId ? "current" : ""}`}>
              <span className="map-badge" aria-hidden="true">{state === "done" ? "✓" : state === "locked" ? "🔒" : n + 1}</span>
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
        })}
      </ol>
    </nav>
  );
}
