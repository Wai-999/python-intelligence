import { useEffect, useRef, useState } from "react";
import type { Intervention, Outcome, Target } from "../learner/loop";
import { counterexampleFor } from "../tutor/counterexamples";
import { inline } from "./Prose";

interface Props {
  intervention: Intervention;
  /** A different exercise on the concept to try without hints afterwards (the independent transfer check), if any. */
  target: Target | null;
  titleOf: (lessonId: string) => string;
  onOutcome: (outcome: Exclude<Outcome, "shown">) => void;
}

/**
 * The meso loop's step back, shown after the tutor note (micro feedback comes first). The learner can always say "Not now".
 */
export function MesoPanel({ intervention: i, target, titleOf, onOutcome }: Props) {
  const ce = i.kind === "counterexample" ? counterexampleFor(i.signature) : null;
  const [chosen, setChosen] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const finish = (outcome: Exclude<Outcome, "shown">) => { setDone(true); onOutcome(outcome); };
  const what = i.signature.startsWith("check:") ? `the check on ${i.signature.slice(6)}` : i.signature.replace(/^error:/, "");

  const transfer = target ? (
    <p className="meso-transfer">Then show yourself it has clicked on a different task, without hints:{" "}
      <a href={`#/lesson/${target.lessonId}/${target.stepIndex}`}>{target.title}</a>
      <span className="muted"> ({titleOf(target.lessonId)})</span>.</p>
  ) : (
    <p className="meso-transfer muted">There isn't another exercise on {i.concept} here that could count as an independent
       check right now.</p>
  );

  return (
    <section className="meso" aria-labelledby="meso-title">
      <h3 id="meso-title" tabIndex={-1} ref={heading}>Let's step back for a moment</h3>
      {i.kind === "independence" ? (
        <>
          <p>Your last few successes on <strong>{i.concept}</strong> leaned on strong hints or the solution. That's fine, and
             the next step is doing one on your own. Hints stay a click away if you need them.</p>
          {transfer}
          {!done && <p><button type="button" className="btn ghost" onClick={() => finish("postponed")}>Not now</button></p>}
        </>
      ) : ce ? (
        <>
          <p>The same kind of error ({what}) has come up a few times. Before changing more code, predict what this does:</p>
          <pre className="code-block"><code>{ce.code}</code></pre>
          <fieldset className="question" disabled={done}>
            <legend>{ce.question}</legend>
            {ce.choices.map((c, k) => (
              <label key={k} className="choice">
                <input type="radio" name="meso-choice" checked={chosen === k} onChange={() => setChosen(k)} /> {c}
              </label>
            ))}
          </fieldset>
          {!done ? (
            <p>
              <button type="button" className="btn primary" disabled={chosen === null} onClick={() => finish("answered")}>Check my prediction</button>{" "}
              <button type="button" className="btn ghost" onClick={() => finish("postponed")}>Not now</button>
            </p>
          ) : chosen !== null && (
            <div role="status">
              <p><strong>{chosen === ce.answer ? "Right." : `Not quite: ${ce.choices[ce.answer]}.`}</strong> {inline(ce.explanation)}</p>
              {transfer}
            </div>
          )}
        </>
      ) : (
        <>
          <p>{i.signature.startsWith("check:") ? <>The check on <strong>{i.signature.slice(6)}</strong> has failed</> : <>The same kind of error ({what}) has come up</>}
             {" "}a few times. Before changing more code, write down two things: what your code gives for the failing case, and
             what the check expects. Then find the first line where they part ways. Explaining it to yourself is often
             faster than another edit.</p>
          {!done ? (
            <p>
              <button type="button" className="btn primary" onClick={() => finish("answered")}>I've compared them</button>{" "}
              <button type="button" className="btn ghost" onClick={() => finish("postponed")}>Not now</button>
            </p>
          ) : <div role="status">{transfer}</div>}
        </>
      )}
    </section>
  );
}
