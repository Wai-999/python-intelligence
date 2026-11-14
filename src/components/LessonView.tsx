import { useEffect, useRef, type ReactNode } from "react";
import { isExercise, isGraded, type Lesson, type Step, type ExerciseStep } from "../content/types";
import type { Recommendation } from "../curriculum/graph";
import type { LessonProgress } from "../progress/types";
import { CodeCell } from "./CodeCell";
import { Exercise, type AttemptDetail } from "./Exercise";
import { inline, Prose } from "./Prose";
import { Quiz } from "./Quiz";
import { FurtherReading, StepSources } from "./Sources";
import { TraceViewer } from "./TraceViewer";

const KIND_LABEL: Record<Step["kind"], string> = {
  motivation: "Why it matters", intuition: "Intuition", visual: "See it run", formal: "The rules",
  example: "Example", guided: "Guided practice", challenge: "Challenge", transfer: "Transfer", quiz: "Check", summary: "Recap",
};

interface Props {
  lesson: Lesson;
  stepIndex: number;
  progress: LessonProgress | undefined;
  drafts: Record<string, string>;
  recommendation: Recommendation;
  /** Prerequisites done? Learners may still browse ahead; we just say so. */
  unlocked: boolean;
  titleOf: (id: string) => string;
  go: (lessonId: string, step: number) => void;
  onExercise: (stepId: string, passed: boolean, failedConcepts: string[], detail: AttemptDetail) => void;
  onQuiz: (stepId: string, score: number, passed: boolean, missed: string[], correct: boolean[]) => void;
  onDraft: (stepId: string, code: string) => void;
  /** Bumped whenever stored progress is replaced (import, reset), so stateful steps rebuild from it. */
  generation: number;
  /** Help seen per exercise step (0..4). */
  assistance: Record<string, number>;
  onAssist: (stepId: string, level: number) => void;
  /** Suggested up-front support for an exercise, from the learner model (see suggestedTier). */
  suggestTier: (step: ExerciseStep) => number;
  /** The meso-loop panel for this lesson's step, if one is showing. */
  mesoFor: (stepId: string) => ReactNode | undefined;
}

export function LessonView(p: Props) {
  const { lesson, stepIndex, progress } = p;
  const step = lesson.steps[stepIndex]!;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [lesson.id, stepIndex]); // move focus for screen readers

  const graded = lesson.steps.filter(isGraded);
  const passedCount = graded.filter((s) => progress?.steps[s.id]?.passed).length;
  const last = stepIndex === lesson.steps.length - 1;
  // Where the lesson metadata appears: the analogy with the intuition (else the motivation), the common mix-ups with
  // the rules (else the first example), since only some step kinds are required in every lesson.
  const firstOf = (...kinds: Step["kind"][]) => kinds.map((k) => lesson.steps.find((s) => s.kind === k)).find(Boolean)?.id;
  const analogyStep = firstOf("intuition", "motivation");
  const mixUpStep = firstOf("formal", "example");

  return (
    <article className="lesson" aria-labelledby="step-title">
      <header className="lesson-head">
        <p className="eyebrow">{lesson.title} · {passedCount}/{graded.length} graded steps passed
          {progress?.completed && <> · <span className="ok">completed ✓</span></>}</p>
        <nav aria-label="Lesson steps">
          <ol className="stepper">
            {lesson.steps.map((s, i) => {
              const done = isGraded(s) ? progress?.steps[s.id]?.passed : i <= (progress?.furthestStep ?? 0);
              return (
                <li key={s.id}>
                  <a href={`#/lesson/${lesson.id}/${i}`} aria-current={i === stepIndex ? "step" : undefined}
                     className={`dot ${i === stepIndex ? "current" : ""} ${done ? "done" : ""} ${isGraded(s) ? "graded" : ""}`}
                     title={`${i + 1}. ${KIND_LABEL[s.kind]}: ${s.title}`}>
                    <span className="sr-only">Step {i + 1}: {s.title}{done ? " (done)" : ""}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>
      </header>

      {!p.unlocked && (
        <p className="pill warn">You're looking ahead. It's best to finish{" "}
          {lesson.prerequisites.map((id, k) => <span key={id}>{k > 0 && ", "}<a href={`#/lesson/${id}/0`}>{p.titleOf(id)}</a></span>)}{" "}
          first. Progress here still counts.</p>
      )}
      <p className="kind">{KIND_LABEL[step.kind]} · step {stepIndex + 1} of {lesson.steps.length}</p>
      <h2 id="step-title" ref={heading} tabIndex={-1}>{step.title}</h2>
      {step.kind === "motivation" && lesson.objective && <p className="objective"><strong>Goal:</strong> {inline(lesson.objective)}</p>}
      <Prose text={step.body} />
      {step.id === analogyStep && lesson.analogy && <p className="analogy"><strong>Analogy:</strong> {inline(lesson.analogy)}</p>}
      {step.id === mixUpStep && lesson.misconceptions && lesson.misconceptions.length > 0 && (
        <details className="misconceptions">
          <summary>Common mix-ups</summary>
          <ul>{lesson.misconceptions.map((m, i) => (
            <li key={i}><strong>Not quite:</strong> {inline(m.belief)} <strong>Instead:</strong> {inline(m.correction)}</li>
          ))}</ul>
        </details>
      )}
      {step.kind === "summary" && lesson.rubric && lesson.rubric.length > 0 && (
        <section className="rubric" aria-labelledby="rubric-title">
          <h3 id="rubric-title">Check your own work</h3>
          <ul>{lesson.rubric.map((r, i) => <li key={i}><strong>{r.criterion}:</strong> {inline(r.evidence)}</li>)}</ul>
        </section>
      )}
      <StepSources lesson={lesson} step={step} />

      {step.kind === "visual" && <TraceViewer key={`${lesson.id}:${step.id}`} visual={step.visual} />}
      {step.kind === "example" && <CodeCell key={`${lesson.id}:${step.id}`} id={`ex-${lesson.id}-${step.id}`} initial={step.code} packages={lesson.packages} />}
      {isExercise(step) && (
        <Exercise key={`${lesson.id}:${step.id}:${p.generation}`} step={step} packages={lesson.packages} lessonId={lesson.id} draft={p.drafts[step.id]}
                  record={progress?.steps[step.id]}
                  assistance={p.assistance[step.id] ?? 0} onAssist={(level) => p.onAssist(step.id, level)} generation={p.generation} suggestedTier={p.suggestTier(step)} meso={p.mesoFor(step.id)}
                  onDraft={(c) => p.onDraft(step.id, c)}
                  onResult={(passed, fc, detail) => p.onExercise(step.id, passed, fc, detail)} />
      )}
      {step.kind === "quiz" && (
        <Quiz key={`${lesson.id}:${step.id}:${p.generation}`} step={step} record={progress?.steps[step.id]}
              onResult={(score, passed, missed, correct) => p.onQuiz(step.id, score, passed, missed, correct)} />
      )}
      {step.kind === "quiz" && p.mesoFor(step.id)}
      {step.kind === "summary" && <NextUp {...p} />}

      <nav className="pager" aria-label="Step navigation">
        <button type="button" className="btn" disabled={stepIndex === 0} onClick={() => p.go(lesson.id, stepIndex - 1)}>← Back</button>
        {!last && <button type="button" className="btn primary" onClick={() => p.go(lesson.id, stepIndex + 1)}>Next →</button>}
      </nav>
    </article>
  );
}

function NextUp({ lesson, progress, recommendation: r, titleOf, go }: Props) {
  const remaining = lesson.steps.map((s, i) => [s, i] as const).filter(([s]) => isGraded(s) && !progress?.steps[s.id]?.passed);
  return (
    <section className="next-up" aria-label="What next">
      {progress?.completed ? (
        <p className="pill ok">Lesson complete, with an estimated mastery of {Math.round(progress.mastery * 100)}%.</p>
      ) : (
        <div className="pill warn">
          To complete this lesson, pass:{" "}
          {remaining.map(([s, i], k) => (
            <span key={s.id}>{k > 0 && ", "}<a href={`#/lesson/${lesson.id}/${i}`}>{s.title}</a></span>
          ))}
        </div>
      )}
      <Recommend r={r} titleOf={titleOf} go={go} currentId={lesson.id} />
      <FurtherReading lesson={lesson} />
    </section>
  );
}

export function Recommend({ r, titleOf, go, currentId }: { r: Recommendation; titleOf: (id: string) => string; go: (id: string, s: number) => void; currentId?: string }) {
  if (r.kind === "done") return <p className="recommend">🎓 You've worked through every lesson available so far. More are on the way.</p>;
  if (r.kind === "continue" && r.lessonId === currentId) return null;
  const label = { remediate: "Review first", continue: "Continue", next: "Next lesson" }[r.kind];
  return (
    <div className="recommend">
      <p className="eyebrow">Recommended</p>
      {r.kind === "remediate" && (
        <p>You've had trouble with <strong>{r.concept}</strong> several times. A short review of the lesson that
           teaches it will make the rest easier.</p>
      )}
      <button type="button" className="btn primary" onClick={() => go(r.lessonId, 0)}>
        {label}: {titleOf(r.lessonId)} →
      </button>
    </div>
  );
}
