import { useEffect, useRef, useState } from "react";
import type { ExerciseStep } from "../content/types";
import { INFRASTRUCTURE_ERRORS, type RunResult } from "../py/protocol";
import { getRunner } from "../py/runner";
import { feedbackForError, feedbackForTests } from "../tutor/feedback";
import { Console, RunBar } from "./CodeCell";
import { Editor } from "./Editor";
import { inline } from "./Prose";
import { TutorNote } from "./TutorNote";
import type { StepResult } from "../progress/types";
import type { Assistance } from "../learner/model";
import { assistanceFor } from "../learner/record";

export interface AttemptDetail {
  /** Each check's concept and outcome, or null when the code didn't run. */
  results: { concept?: string; passed: boolean }[] | null;
  assistance: Assistance;
  /** The progress generation the run started in; results from before an import or reset are discarded. */
  generation: number;
}

interface Props {
  step: ExerciseStep;
  packages?: string[];
  lessonId: string;
  draft: string | undefined;
  record: StepResult | undefined;
  /** Help already seen on this task in earlier visits (0..4); it is restored, never forgotten. */
  assistance: number;
  onAssist: (level: Assistance) => void;
  generation: number;
  onDraft: (code: string) => void;
  onResult: (passed: boolean, failedConcepts: string[], detail: AttemptDetail) => void;
}

/** Hints are revealed one at a time. The solution becomes available only after this many failed attempts. */
export const SOLUTION_AFTER = 2;

export function Exercise({ step, packages, lessonId, draft, record, assistance, onAssist, generation, onDraft, onResult }: Props) {
  const [code, setCode] = useState(draft ?? step.starter);
  const [result, setResult] = useState<RunResult | null>(null);
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState(false);
  // Earlier help is shown again on return, and counted: reopening a task never makes it count as unaided.
  const [hintsShown, setHintsShown] = useState(() => Math.min(step.hints.length, assistance >= 4 ? step.hints.length : assistance));
  const [failures, setFailures] = useState(record && !record.passed ? record.attempts : 0);
  const [confirmSolution, setConfirmSolution] = useState(false);
  const [showSolution, setShowSolution] = useState(assistance >= 4);
  // The highest help seen so far, read when a run finishes (help revealed while a run is pending counts too).
  const helped = useRef<Assistance>(assistanceFor(Math.min(3, assistance), assistance >= 4));
  const reveal = (hints: number, solution: boolean) => {
    const level = assistanceFor(hints, solution);
    if (level > helped.current) { helped.current = level; onAssist(level); }
  };
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { setCode(draft ?? step.starter); }, [step.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (v: string) => {
    setCode(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onDraft(v), 400); // autosave drafts (IndexedDB)
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // One run at a time, whether started by the button or the keyboard shortcut.
  const running = useRef(false);
  const check = async () => {
    if (running.current) return;
    running.current = true;
    const startedIn = generation;
    clearTimeout(saveTimer.current);
    onDraft(code);
    setBusy(true);
    setResult(null);
    setLive("");
    try {
      const r = await getRunner().run(code, step.tests, { packages, onOutput: (_s, t) => setLive((x) => x + t) });
      setResult(r);
      if (r.error && INFRASTRUCTURE_ERRORS.has(r.error.type)) return; // the system failed, not the learner: no attempt
      const passed = r.ok && r.tests.length === step.tests.length && r.tests.every((t) => t.passed);
      const failedConcepts = r.ok
        ? r.tests.filter((t) => !t.passed).map((t) => t.concept).filter((c): c is string => !!c)
        : step.tests.map((t) => t.concept).filter((c): c is string => !!c).slice(0, 1);
      if (!passed) setFailures((n) => n + 1);
      onResult(passed, failedConcepts, {
        results: r.ok ? r.tests.map((t) => ({ concept: t.concept ?? undefined, passed: t.passed })) : null,
        assistance: helped.current,
        generation: startedIn,
      });
    } catch (e) {
      setResult({ ok: false, tests: [], stdout: "", stderr: "", durationMs: 0,
        error: { type: "LoadError", message: String((e as Error).message), line: null, summary: String((e as Error).message) } });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const fb = result
    ? result.error && !INFRASTRUCTURE_ERRORS.has(result.error.type) ? feedbackForError(result.error) : result.error ? null : feedbackForTests(result.tests)
    : null;
  const allPassed = !!result && result.ok && result.tests.every((t) => t.passed);
  const edId = `ed-${lessonId}-${step.id}`;

  return (
    <section className="cell exercise" aria-label={step.kind === "challenge" ? "Challenge" : "Guided exercise"}>
      {record?.passed && !result && <p className="pill ok">✓ Completed earlier. You can keep experimenting.</p>}
      <Editor id={edId} label="Your solution" value={code} onChange={change} onRun={check} />
      <RunBar onRun={check} onReset={() => change(step.starter)} busy={busy} packages={packages} runLabel="Run checks" />
      <Console result={result} live={live} />

      {result && result.ok && (
        <ul className="checks" aria-label="Check results">
          {result.tests.map((t) => (
            <li key={t.name} className={t.passed ? "pass" : "fail"}>
              <span aria-hidden="true">{t.passed ? "✓" : "✗"}</span> {t.name}
              <span className="sr-only">{t.passed ? " passed" : " failed"}</span>
              {!t.passed && <div className="check-msg">{t.message}</div>}
            </li>
          ))}
        </ul>
      )}
      {allPassed && <p className="pill ok" role="status">🎉 All checks pass. Nicely done.</p>}
      {fb && !allPassed && <TutorNote fb={fb} />}

      {!allPassed && step.socratic && failures === 0 && (
        <details className="socratic"><summary>Before you start, think about…</summary>
          <ul>{step.socratic.questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </details>
      )}

      <div className="hints">
        {step.hints.slice(0, hintsShown).map((h, i) => (
          // Prose hints end with a period; bare code hints (usually the last, most explicit one) don't.
          <p key={i} className="hint"><strong>Hint {i + 1}:</strong>{" "}
            {/[.!?]$/.test(h.trim()) ? inline(h) : <code className="hint-code">{h}</code>}</p>
        ))}
        {hintsShown < step.hints.length && !allPassed && (
          <button type="button" className="btn ghost" onClick={() => { setHintsShown(hintsShown + 1); reveal(hintsShown + 1, showSolution); }}>
            {hintsShown === 0 ? "Show a hint" : "Another hint"} ({step.hints.length - hintsShown} left)
          </button>
        )}
        {failures >= SOLUTION_AFTER && !allPassed && !showSolution && (
          confirmSolution ? (
            <span className="confirm">
              Seeing the answer is fine, but you learn more by trying one more time.{" "}
              <button type="button" className="btn" onClick={() => { setShowSolution(true); reveal(hintsShown, true); }}>Show it anyway</button>{" "}
              <button type="button" className="btn ghost" onClick={() => setConfirmSolution(false)}>I'll try again</button>
            </span>
          ) : (
            <button type="button" className="btn ghost" onClick={() => setConfirmSolution(true)}>Show the solution…</button>
          )
        )}
        {showSolution && (
          <div className="solution">
            <p><strong>One correct solution</strong> (type it out yourself instead of copying):</p>
            <pre className="code-block"><code>{step.solution}</code></pre>
          </div>
        )}
      </div>
    </section>
  );
}
