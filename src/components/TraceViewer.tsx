import { useState } from "react";
import type { VisualStep } from "../content/types";

/** Step-through visualisation of a program's execution: current line, call stack, local names, output. */
export function TraceViewer({ visual }: { visual: VisualStep["visual"] }) {
  const [i, setI] = useState(0);
  const frames = visual.frames;
  const f = frames[i]!;
  const lines = visual.code.split("\n");
  const output = frames.slice(0, i + 1).map((x) => x.output).filter(Boolean).join("\n");

  return (
    <section className="trace" aria-label="Execution visualiser">
      <div className="trace-grid">
        <ol className="trace-code" aria-label="Program">
          {lines.map((l, n) => (
            <li key={n} className={n + 1 === f.line ? "active" : ""} aria-current={n + 1 === f.line ? "step" : undefined}>
              <span className="ln" aria-hidden="true">{n + 1}</span>
              <code>{l || " "}</code>
            </li>
          ))}
        </ol>
        <div className="trace-state">
          <h4>Call stack</h4>
          <ol className="stack">
            {[...f.stack].reverse().map((s, k) => <li key={k} className={k === 0 ? "top" : ""}><code>{s}</code></li>)}
          </ol>
          <h4>Names in the active frame</h4>
          {Object.keys(f.locals).length === 0 ? <p className="muted">(none yet)</p> : (
            <table className="locals">
              <thead><tr><th scope="col">name</th><th scope="col">value</th></tr></thead>
              <tbody>{Object.entries(f.locals).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td><code>{v}</code></td></tr>)}</tbody>
            </table>
          )}
          <h4>Output</h4>
          <pre className="trace-out">{output || " "}</pre>
        </div>
      </div>
      <p className="trace-note" aria-live="polite"><strong>Step {i + 1} of {frames.length}, line {f.line}:</strong> {f.note.replace(/`/g, "")}</p>
      <div className="run-bar">
        <button type="button" className="btn" onClick={() => setI(0)} disabled={i === 0}>⏮ Start</button>
        <button type="button" className="btn" onClick={() => setI(i - 1)} disabled={i === 0}>◀ Back</button>
        <button type="button" className="btn primary" onClick={() => setI(i + 1)} disabled={i === frames.length - 1}>Step ▶</button>
      </div>
    </section>
  );
}
