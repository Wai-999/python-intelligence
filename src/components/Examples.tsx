import { useEffect, useRef, useState } from "react";
import type { ExampleStep } from "../content/types";
import { CodeCell } from "./CodeCell";
import { inline, Prose } from "./Prose";

/**
 * An example step's code cell, with "Try another example" (master prompt §5) cycling through further worked examples
 * of the same idea. Each one's output is checked by the content gate, like the main example's.
 */
export function Examples({ lessonId, step, packages }: { lessonId: string; step: ExampleStep; packages?: string[] }) {
  const all = [{ title: null as string | null, body: null as string | null, code: step.code }, ...(step.more ?? []).map((m) => ({ title: m.title, body: m.body, code: m.code }))];
  const [i, setI] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  useEffect(() => { if (moved.current) heading.current?.focus(); }, [i]);
  const shown = all[i]!;
  return (
    <div className="examples">
      {shown.title && (
        <div className="another">
          <h3 ref={heading} tabIndex={-1}>Another example: {inline(shown.title)}</h3>
          {shown.body && <Prose text={shown.body} />}
        </div>
      )}
      <CodeCell key={`${lessonId}:${step.id}:${i}`} id={`ex-${lessonId}-${step.id}-${i}`} initial={shown.code} packages={packages} />
      {all.length > 1 && (
        <p className="another-bar">
          <button type="button" className="btn" onClick={() => { moved.current = true; setI((i + 1) % all.length); }}>
            {i + 1 < all.length ? "Try another example" : "Back to the first example"}
          </button>{" "}
          <span className="muted">example {i + 1} of {all.length}</span>
        </p>
      )}
    </div>
  );
}
