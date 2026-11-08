import { cite, type Citation } from "../content/citations";
import type { Lesson, SourceRef, Step } from "../content/types";

/** “Section title”, linked to the exact section for web sources. */
function Section({ c }: { c: Citation }) {
  return c.sectionUrl
    ? <a href={c.sectionUrl} target="_blank" rel="noopener noreferrer">“{c.section}”</a>
    : <>“{c.section}”</>;
}

const resolve = (refs: SourceRef[]): Citation[] => refs.map((r) => cite(r)).filter((c): c is Citation => c !== null);

/** One line under a step: which book sections its claims rest on. Nothing for steps that cite nothing. */
export function StepSources({ lesson, step }: { lesson: Lesson; step: Step }) {
  const ids = step.cites ?? [];
  const cs = resolve(lesson.sources.filter((s) => ids.includes(s.id)));
  if (!cs.length) return null;
  return (
    <p className="step-sources">
      <span className="eyebrow">Source{cs.length > 1 ? "s" : ""}</span>{" "}
      {cs.map((c, i) => (
        <span key={c.id}>{i > 0 && "; "}<cite>{c.book}</cite>, <Section c={c} />{c.sectionUrl ? "" : `, ${c.pages}`}</span>
      ))}
    </p>
  );
}

/** Full references, one entry per book, with licences and links to the official free editions. */
export function FurtherReading({ lesson }: { lesson: Lesson }) {
  const books = new Map<string, Citation[]>();
  for (const c of resolve(lesson.sources)) books.set(c.title, [...(books.get(c.title) ?? []), c]);
  if (!books.size) return null;
  return (
    <section className="further-reading" aria-label="Further reading">
      <h3>Further reading</h3>
      <ul>
        {[...books.values()].map((cs) => {
          const c = cs[0]!;
          const adapted = cs.some((x) => x.adapted);
          return (
            <li key={c.title}>
              {c.authors}, <a href={c.url} target="_blank" rel="noopener noreferrer"><cite>{c.title}</cite></a>:{" "}
              {cs.map((x, i) => <span key={x.id}>{i > 0 && "; "}<Section c={x} />{x.sectionUrl ? "" : `, ${x.pages}`}</span>)}.{" "}
              <span className="muted">Free online; <a href={c.licenseUrl} target="_blank" rel="noopener noreferrer">{c.license}</a>.
                {adapted ? " This lesson adapts this material under the same licence." : " This lesson is original writing that points to it."}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
