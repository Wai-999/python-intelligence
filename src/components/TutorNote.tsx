import type { Feedback } from "../tutor/feedback";

/** The offline tutor is rule-based. The label says so, so nobody mistakes it for a generative AI. */
export function TutorNote({ fb, title = "Professor's note" }: { fb: Feedback; title?: string }) {
  return (
    <aside className="tutor" aria-label={title}>
      <header>
        <span aria-hidden="true">🎓</span> <strong>{title}</strong>
        <span className="badge" title="Pre-written guidance matched to your result; not an AI model">offline guide</span>
      </header>
      <p>{fb.diagnosis}</p>
      <p><strong>Ask yourself:</strong> {fb.question}</p>
      <p><strong>Try:</strong> {fb.action}</p>
    </aside>
  );
}
