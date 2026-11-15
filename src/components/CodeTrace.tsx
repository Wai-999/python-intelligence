import { useEffect, useRef, useState } from "react";
import { getRunner } from "../py/runner";
import type { RunResult } from "../py/protocol";
import { TraceViewer } from "./TraceViewer";

/**
 * §5 "Show execution trace" for the learner's own code: runs the editor's current code once with the harness's tracer
 * and steps through it in the same viewer the lessons use. A changed editor clears the trace, so it never shows code
 * that is no longer there.
 */
export function CodeTrace({ code, packages }: { code: string; packages?: string[] }) {
  const [traced, setTraced] = useState<{ code: string; result: RunResult; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null); // Python itself couldn't start; the button retries
  const runs = useRef(0);
  useEffect(() => { if (traced && traced.code !== code) setTraced(null); }, [code, traced]);

  const trace = async () => {
    setBusy(true);
    setFailed(null);
    try {
      setTraced({ code, result: await getRunner().run(code, [], { packages, trace: true }), n: ++runs.current });
    } catch (e) {
      setTraced(null);
      setFailed(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const frames = traced?.result.trace?.frames ?? [];
  return (
    <div className="code-trace">
      <button type="button" className="btn" onClick={trace} disabled={busy} aria-busy={busy} aria-expanded={!!traced}>
        {busy ? "Tracing…" : traced ? "Trace again" : "Show execution trace"}
      </button>
      {failed && <p className="pill bad" role="status">Couldn't trace this: {failed} Press the button to try again.</p>}
      {traced && (frames.length > 0 ? (
        <>
          {traced.result.trace!.truncated && <p className="muted">Showing the first {traced.result.trace!.limit} steps; the program kept running after that.</p>}
          {traced.result.trace!.outputCut && <p className="muted">The trace keeps only the first 100,000 characters of output.</p>}
          <TraceViewer key={traced.n} visual={{ type: "call-trace", code: traced.code, frames, exactOutput: true }} lead={false} />
        </>
      ) : (
        <p className="pill warn" role="status">No trace: {traced.result.error?.summary ?? "the code has no lines to run."}</p>
      ))}
    </div>
  );
}
