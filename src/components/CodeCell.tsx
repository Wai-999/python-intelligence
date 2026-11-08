import { useState } from "react";
import type { RunResult } from "../py/protocol";
import { getRunner } from "../py/runner";
import { feedbackForError } from "../tutor/feedback";
import { Editor } from "./Editor";
import { STATUS_TEXT, usePythonStatus } from "./usePython";
import { TutorNote } from "./TutorNote";

export function Console({ result, live }: { result: RunResult | null; live: string }) {
  const text = result ? result.stdout + result.stderr : live;
  return (
    <div className="console" role="log" aria-live="polite" aria-label="Program output">
      {text ? <pre>{text}</pre> : <p className="muted">Output appears here.</p>}
      {result?.error && (
        <pre className="console-error">{result.error.summary}{result.error.line ? `  (line ${result.error.line})` : ""}</pre>
      )}
    </div>
  );
}

export function RunBar({ onRun, onReset, busy, runLabel = "Run" }: { onRun: () => void; onReset?: () => void; busy: boolean; runLabel?: string }) {
  const status = usePythonStatus();
  return (
    <div className="run-bar">
      <button type="button" className="btn primary" onClick={onRun} disabled={busy} aria-busy={busy}>
        {busy ? "Running…" : `▶ ${runLabel}`}
      </button>
      {onReset && <button type="button" className="btn" onClick={onReset} disabled={busy}>Reset</button>}
      <span className={`py-status py-${status}`} role="status">{STATUS_TEXT[status]}</span>
    </div>
  );
}

export function CodeCell({ id, initial }: { id: string; initial: string }) {
  const [code, setCode] = useState(initial);
  const [result, setResult] = useState<RunResult | null>(null);
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setResult(null);
    setLive("");
    try {
      const r = await getRunner().run(code, [], { onOutput: (_s, t) => setLive((x) => x + t) });
      setResult(r);
    } catch (e) {
      setResult({ ok: false, tests: [], stdout: "", stderr: "", durationMs: 0,
        error: { type: "LoadError", message: String((e as Error).message), line: null, summary: String((e as Error).message) } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cell" aria-label="Runnable example">
      <Editor id={id} label="Example code" value={code} onChange={setCode} onRun={run} />
      <RunBar onRun={run} onReset={() => { setCode(initial); setResult(null); }} busy={busy} />
      <Console result={result} live={live} />
      {result?.error && result.error.type !== "LoadError" && <TutorNote fb={feedbackForError(result.error)} />}
    </section>
  );
}
