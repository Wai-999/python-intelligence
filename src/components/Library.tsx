import { useEffect, useRef } from "react";
import { buildLibrary } from "../content/library";
import { LESSONS } from "../content/lessons";

const LIBRARY = buildLibrary(LESSONS);

/** All the books and documentation the lessons draw on, each with the lessons and sections that cite it. */
export function Library() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const books = LIBRARY.filter((e) => e.source.kind !== "web");
  const docs = LIBRARY.filter((e) => e.source.kind === "web");
  return (
    <article className="library" aria-labelledby="library-title">
      <h1 id="library-title" ref={heading} tabIndex={-1}>Library</h1>
      <p className="lede">The lessons are original writing, built on {books.length} free books and the official
        documentation. Every claim cites its source by section and page, so you can always read the full
        explanation. Here is the whole shelf, with the lessons that use each book.</p>
      <h2>Books</h2>
      <ul className="shelf">{books.map((e) => <Entry key={e.sourceId} e={e} />)}</ul>
      <h2>Official documentation</h2>
      <ul className="shelf">{docs.map((e) => <Entry key={e.sourceId} e={e} />)}</ul>
    </article>
  );
}

function Entry({ e }: { e: (typeof LIBRARY)[number] }) {
  const s = e.source;
  return (
    <li className="shelf-item">
      <h3><a href={s.official_url} target="_blank" rel="noopener noreferrer"><cite>{s.title}</cite></a></h3>
      <p className="muted">{s.authors.join(", ")} · <a href={s.license_url} target="_blank" rel="noopener noreferrer">{s.license}</a>
        {s.reference_only && <> · <span className="tag">reference only</span></>}</p>
      {e.uses.length ? (
        <ul className="uses">
          {e.uses.map((u) => (
            <li key={u.lessonId}>
              <a href={`#/lesson/${u.lessonId}/0`}>{u.lessonTitle}</a>:{" "}
              {u.citations.map((c, i) => <span key={c.id}>{i > 0 && "; "}“{c.section}”{c.sectionUrl ? "" : `, ${c.pages}`}</span>)}
            </li>
          ))}
        </ul>
      ) : <p className="muted">Not cited by a lesson yet.</p>}
    </li>
  );
}
