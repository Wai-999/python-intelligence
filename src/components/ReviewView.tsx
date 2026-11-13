import { useEffect, useRef, useState } from "react";
import type { Lesson } from "../content/types";
import { dueReviews, type ConceptState, type LearnerEvent, type LearnerModel } from "../learner/model";
import { reviewItem, type ReviewItem } from "../learner/record";
import { inline } from "./Prose";

const STATUS: Record<ConceptState["status"], string> = {
  new: "not started", learning: "learning", complete: "complete (reviews pending)", mastered: "durably mastered",
};

interface Props {
  lessons: Lesson[];
  model: LearnerModel;
  events: LearnerEvent[];
  now: string;
  titleOf: (lessonId: string) => string;
  onAnswer: (item: ReviewItem, correct: boolean) => void;
}

/** Spaced retrieval (master prompt §5): due concepts one question at a time, then the evidence behind each concept. */
export function ReviewView({ lessons, model, events, now, titleOf, onAnswer }: Props) {
  // Only concepts with a question of their own can be reviewed; the others are listed, never faked.
  const allDue = dueReviews(model, now);
  const due = allDue.filter((s) => reviewItem(lessons, s.concept, 0) !== null);
  const unreviewable = allDue.filter((s) => reviewItem(lessons, s.concept, 0) === null);
  // While an answer's feedback is showing, keep that question on screen even though the schedule has moved on.
  const [shown, setShown] = useState<{ item: ReviewItem; chosen: number } | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  // Keyboard and screen-reader users keep their place: the heading on entry, then each next question (or the
  // "nothing due" message) after advancing, since the button they pressed disappears.
  const heading = useRef<HTMLHeadingElement>(null);
  const questionLine = useRef<HTMLParagraphElement>(null);
  const emptyLine = useRef<HTMLParagraphElement>(null);
  const [advanced, setAdvanced] = useState(0);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { if (advanced > 0) (questionLine.current ?? emptyLine.current)?.focus(); }, [advanced]);
  const next = due[0];
  const turn = next ? events.filter((e) => e.task === "review" && e.concept === next.concept).length : 0;
  const item = shown?.item ?? (next ? reviewItem(lessons, next.concept, turn) : null);
  const started = [...model.concepts.values()].filter((s) => s.status !== "new")
    .sort((a, b) => (a.reviewDue ?? "~").localeCompare(b.reviewDue ?? "~") || a.concept.localeCompare(b.concept));

  const submit = () => {
    if (!item || chosen === null) return;
    setShown({ item, chosen });
    onAnswer(item, chosen === item.question.answer);
  };

  return (
    <section className="review" aria-labelledby="review-title">
      <h1 id="review-title" tabIndex={-1} ref={heading}>Review</h1>
      <p>Short questions on concepts you completed earlier, spaced out over days so they stick: 1 day after you finish
         a concept, then 3, 7, 14 and 30 days. A wrong answer, or one you needed help with, starts the spacing again.</p>

      {item ? (
        <form className="quiz" onSubmit={(e) => { e.preventDefault(); if (!shown) submit(); }}>
          <p className="eyebrow" tabIndex={-1} ref={questionLine}>{shown ? "Review" : `${due.length} due`} · {item.concept} · from {titleOf(item.lessonId)}</p>
          <fieldset className="question" disabled={!!shown}>
            <legend>{inline(item.question.prompt)}</legend>
            {item.question.code && <pre className="code-block"><code>{item.question.code}</code></pre>}
            {item.question.choices.map((c, ci) => {
              const mark = shown ? (ci === item.question.answer ? "right" : ci === shown.chosen ? "wrong" : "") : "";
              return (
                <label key={ci} className={`choice ${mark}`}>
                  <input type="radio" name={`review-${item.question.id}`} checked={(shown?.chosen ?? chosen) === ci} onChange={() => setChosen(ci)} />
                  <span>{inline(c)}</span>
                  {mark === "right" && <span className="sr-only"> (correct answer)</span>}
                  {mark === "wrong" && <span className="sr-only"> (your answer, incorrect)</span>}
                </label>
              );
            })}
          </fieldset>
          {shown ? (
            <div role="status" className={shown.chosen === item.question.answer ? "pill ok" : "pill warn"}>
              {shown.chosen === item.question.answer ? "Correct. " : "Not quite. "}{inline(item.question.explanation)}{" "}
              <button type="button" className="btn primary" onClick={() => { setShown(null); setChosen(null); setAdvanced((n) => n + 1); }}>
                {due.length > 0 ? "Next review" : "Done"}
              </button>
            </div>
          ) : (
            <button type="submit" className="btn primary" disabled={chosen === null}>Check answer</button>
          )}
        </form>
      ) : (
        <p className="pill ok" role="status" tabIndex={-1} ref={emptyLine}>Nothing is due for review right now.</p>
      )}

      {unreviewable.length > 0 && (
        <p className="muted">Also due, but without a review question yet: {unreviewable.map((s) => s.concept).join(", ")}.
           Revisit their lessons instead; these reviews aren't counted.</p>
      )}

      <h2>Your concepts</h2>
      {started.length === 0 ? <p className="muted">Concepts appear here once you start practising them.</p> : (
        <div className="table-scroll">
          <table className="concepts">
            <caption className="sr-only">Evidence for each concept you have practised</caption>
            <thead><tr><th scope="col">Concept</th><th scope="col">Lesson</th><th scope="col">Status</th>
              <th scope="col">Estimate <span className="muted">(heuristic)</span></th><th scope="col">Next review</th></tr></thead>
            <tbody>
              {started.map((s) => (
                <tr key={s.concept}>
                  <th scope="row">{s.concept}</th>
                  <td><a href={`#/lesson/${s.lessonId}/0`}>{titleOf(s.lessonId)}</a></td>
                  <td>{STATUS[s.status]}{!s.prerequisitesMet && s.evidenceReady ? " · finish its prerequisites" : ""}</td>
                  <td>{Math.round(s.masteryEstimate * 100)}% <span className="muted">({s.uncertainty} uncertainty)</span></td>
                  <td>{!s.reviewDue ? "—" : reviewItem(lessons, s.concept, 0) === null ? "no review question yet"
                    : new Date(s.reviewDue).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
