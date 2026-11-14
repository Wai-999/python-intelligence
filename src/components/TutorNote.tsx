import type { Feedback } from "../tutor/feedback";

/** The offline tutor is rule-based. The label says so, so nobody mistakes it for a generative AI. */
/** `collapsed`: another guidance panel is open, so the note shows its diagnosis as a summary line that can be opened. */
export function TutorNote({ fb, title = "Professor's note", collapsed = false }: { fb: Feedback; title?: string; collapsed?: boolean }) {
  const head = (
    <header>
      <span aria-hidden="true">🎓</span> <strong>{title}</strong>
      <span className="badge" title="Pre-written guidance matched to your result; not an AI model">offline guide</span>
    </header>
  );
  const rest = (
    <>
      <p><strong>Ask yourself:</strong> {fb.question}</p>
      <p><strong>Try:</strong> {fb.action}</p>
    </>
  );
  if (collapsed) {
    return (
      <aside className="tutor collapsed" aria-label={title} data-collapsed="">
        {head}
        <details><summary>{fb.diagnosis}</summary>{rest}</details>
      </aside>
    );
  }
  return (
    <aside className="tutor" aria-label={title}>
      {head}
      <p>{fb.diagnosis}</p>
      {rest}
    </aside>
  );
}
