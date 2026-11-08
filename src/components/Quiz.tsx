import { useState } from "react";
import type { QuizStep } from "../content/types";
import type { StepResult } from "../progress/types";
import { inline } from "./Prose";

interface Props {
  step: QuizStep;
  record: StepResult | undefined;
  onResult: (score: number, passed: boolean, missedConcepts: string[]) => void;
}

export function Quiz({ step, record, onResult }: Props) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const all = step.questions.every((q) => answers[q.id] !== undefined);
  const correct = step.questions.filter((q) => answers[q.id] === q.answer).length;
  const score = correct / step.questions.length;

  const submit = () => {
    setSubmitted(true);
    const missed = step.questions.filter((q) => answers[q.id] !== q.answer).map((q) => q.concept);
    onResult(score, score >= step.pass_mark, missed);
  };

  return (
    <form className="quiz" onSubmit={(e) => { e.preventDefault(); if (all) submit(); }}>
      {record?.passed && !submitted && <p className="pill ok">✓ Passed earlier (best {Math.round((record.score ?? 1) * 100)}%).</p>}
      {step.questions.map((q, qi) => {
        const name = `${step.id}-${q.id}`;
        const chosen = answers[q.id];
        return (
          <fieldset key={q.id} className="question" disabled={submitted}>
            <legend><span className="qnum">{qi + 1}.</span> {inline(q.prompt)}</legend>
            {q.code && <pre className="code-block"><code>{q.code}</code></pre>}
            {q.choices.map((c, ci) => {
              const state = submitted ? (ci === q.answer ? "right" : ci === chosen ? "wrong" : "") : "";
              return (
                <label key={ci} className={`choice ${state}`}>
                  <input type="radio" name={name} checked={chosen === ci}
                         onChange={() => setAnswers((a) => ({ ...a, [q.id]: ci }))} />
                  <span>{inline(c.startsWith("def ") || /[()=]/.test(c) ? `\`${c}\`` : c)}</span>
                  {state === "right" && <span className="sr-only"> (correct answer)</span>}
                  {state === "wrong" && <span className="sr-only"> (your answer, incorrect)</span>}
                </label>
              );
            })}
            {submitted && (
              <p className={chosen === q.answer ? "explain ok" : "explain bad"}>
                {chosen === q.answer ? "Correct. " : "Not quite. "}{inline(q.explanation)}
              </p>
            )}
          </fieldset>
        );
      })}
      {!submitted ? (
        <button type="submit" className="btn primary" disabled={!all}>Check answers</button>
      ) : (
        <div role="status" className={score >= step.pass_mark ? "pill ok" : "pill warn"}>
          You scored {correct}/{step.questions.length}.{" "}
          {score >= step.pass_mark ? "Passed!" : `You need ${Math.ceil(step.pass_mark * step.questions.length)} to pass. Review the explanations, then try again.`}
          {score < step.pass_mark && (
            <button type="button" className="btn" onClick={() => { setSubmitted(false); setAnswers({}); }}>Try again</button>
          )}
        </div>
      )}
    </form>
  );
}
