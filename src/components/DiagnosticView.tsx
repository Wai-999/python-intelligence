import { useEffect, useRef, useState } from "react";
import type { Recommendation } from "../curriculum/graph";
import type { Answer, Diagnostic, Placement } from "../curriculum/placement";
import { inline } from "./Prose";

interface Props {
  diagnostic: Diagnostic;
  /** Placement from the latest recorded run (updates once a run is recorded). */
  placement: Placement;
  recommendation: Recommendation;
  titleOf: (id: string) => string;
  go: (lessonId: string, step: number) => void;
  /** Called once per run, when it ends: the answers given so far (unreached questions are left out). */
  onFinish: (answers: Record<string, Answer>) => void;
}

const UNSURE = -1;

export function DiagnosticView({ diagnostic, placement, recommendation, titleOf, go, onFinish }: Props) {
  const [phase, setPhase] = useState<"intro" | "run" | "done">("intro");
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [checked, setChecked] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [phase, index]);

  const cps = diagnostic.checkpoints;
  const cp = cps[index];
  const all = !!cp && cp.questions.every((q) => answers[q.id] !== undefined);
  const allRight = !!cp && cp.questions.every((q) => answers[q.id] === q.answer);

  const finish = (given: Record<string, number>) => {
    onFinish(Object.fromEntries(Object.entries(given).map(([k, v]) => [k, v === UNSURE ? null : v])));
    setPhase("done");
  };
  const start = () => { setAnswers({}); setIndex(0); setChecked(false); setPhase("run"); };

  if (phase === "intro") {
    return (
      <section className="diagnostic" aria-labelledby="diag-title">
        <h1 id="diag-title" ref={heading} tabIndex={-1}>Find your starting point</h1>
        <p>A short placement check: {cps.length} groups of questions, from the basics upwards. Answer without running anything,
           and choose <em>Not sure</em> rather than guessing. You stop at the first group you don't know yet, and that's where
           you start.</p>
        <p className="muted">Lessons you test out of open up what comes after them, but they are <strong>not</strong> marked as
           completed and earn no mastery: you can study them any time. Your answers stay in this browser.</p>
        {placement.at && <PlacementSummary placement={placement} diagnostic={diagnostic} titleOf={titleOf} />}
        <button type="button" className="btn primary" onClick={start}>{placement.at ? "Take it again" : "Start the placement check"}</button>
      </section>
    );
  }

  if (phase === "done" || !cp) {
    return (
      <section className="diagnostic" aria-labelledby="diag-title">
        <h1 id="diag-title" ref={heading} tabIndex={-1}>Your starting point</h1>
        <div role="status"><PlacementSummary placement={placement} diagnostic={diagnostic} titleOf={titleOf} /></div>
        {recommendation.kind !== "done" && (
          <button type="button" className="btn primary" onClick={() => go(recommendation.lessonId, 0)}>
            Start: {titleOf(recommendation.lessonId)} →
          </button>
        )}{" "}
        <a className="btn" href="#/">See the course map</a>
      </section>
    );
  }

  return (
    <section className="diagnostic" aria-labelledby="diag-title">
      <p className="kind">Placement check · group {index + 1} of {cps.length}</p>
      <h1 id="diag-title" ref={heading} tabIndex={-1}>{cp.title}</h1>
      <form className="quiz" onSubmit={(e) => { e.preventDefault(); if (all) setChecked(true); }}>
        {cp.questions.map((q, qi) => {
          const chosen = answers[q.id];
          return (
            <fieldset key={q.id} className="question" disabled={checked}>
              <legend><span className="qnum">{qi + 1}.</span> {inline(q.prompt)}</legend>
              {q.code && <pre className="code-block"><code>{q.code}</code></pre>}
              {[...q.choices.map((c, ci) => [ci, c] as const), [UNSURE, "Not sure"] as const].map(([ci, c]) => {
                const state = checked ? (ci === q.answer ? "right" : ci === chosen ? "wrong" : "") : "";
                return (
                  <label key={ci} className={`choice ${state}`}>
                    <input type="radio" name={`diag-${q.id}`} checked={chosen === ci} onChange={() => setAnswers((a) => ({ ...a, [q.id]: ci }))} />
                    <span>{ci === UNSURE ? <em>{c}</em> : q.output ? <code>{c}</code> : inline(c)}</span>
                    {state === "right" && <span className="sr-only"> (correct answer)</span>}
                    {state === "wrong" && <span className="sr-only"> (your answer, incorrect)</span>}
                  </label>
                );
              })}
              {checked && <p className={chosen === q.answer ? "explain ok" : "explain bad"}>{chosen === q.answer ? "Correct. " : "Not yet. "}{inline(q.explanation)}</p>}
            </fieldset>
          );
        })}
        {!checked ? (
          <div className="diag-actions">
            <button type="submit" className="btn primary" disabled={!all}>Check answers</button>{" "}
            {/* Stopping before checking records this group as "not sure": it can't count as passed, and the run is still
                recorded, so it replaces an older placement even when nothing was answered yet. */}
            <button type="button" className="btn" onClick={() => finish({ ...answers, ...Object.fromEntries(cp.questions.map((q) => [q.id, UNSURE])) })}>
              Stop here and start at this group</button>
          </div>
        ) : allRight && index + 1 < cps.length ? (
          <div role="status" className="pill ok">All correct: you can skip these lessons.{" "}
            <button type="button" className="btn primary" onClick={() => { setIndex(index + 1); setChecked(false); }}>Next group →</button>
          </div>
        ) : (
          <div role="status" className={allRight ? "pill ok" : "pill warn"}>
            {allRight ? "All correct: that was the last group." : "This group is new to you, so this is where you start."}{" "}
            <button type="button" className="btn primary" onClick={() => finish(answers)}>See your starting point</button>
          </div>
        )}
      </form>
    </section>
  );
}

function PlacementSummary({ placement, diagnostic, titleOf }: { placement: Placement; diagnostic: Diagnostic; titleOf: (id: string) => string }) {
  const tested = diagnostic.checkpoints.filter((c) => placement.passed.includes(c.id)).flatMap((c) => c.covers);
  return (
    <div className="placement">
      {tested.length === 0 ? <p>You'll start from the first lesson: nothing was skipped.</p> : (
        <>
          <p>You tested out of {tested.length} lesson{tested.length === 1 ? "" : "s"}:</p>
          <ul>{tested.map((id) => <li key={id}><a href={`#/lesson/${id}/0`}>{titleOf(id)}</a></li>)}</ul>
          <p className="muted">They aren't marked as completed; open any of them to study or check it.</p>
        </>
      )}
      {placement.at && <p className="muted">Placement recorded {new Date(placement.at).toLocaleString()}.</p>}
    </div>
  );
}
