import { useEffect, useRef, useState } from "react";
import type { ProgressExport, ProgressStore } from "../progress/types";

/** The newest time anything with a timestamp was saved: a step result, the reading position or a learner event. */
export function lastSaved(data: ProgressExport): string | null {
  const times = [...data.lessons.flatMap((l) => Object.values(l.steps).map((s) => s.updatedAt)), ...data.events.map((e) => e.at)];
  if (data.position) times.push(data.position.updatedAt);
  // By instant, not by string: imported times may carry different UTC offsets. The original text is kept for display.
  return times.reduce<string | null>((best, t) => (best === null || Date.parse(t) > Date.parse(best) ? t : best), null);
}

/** Export/import/reset. Progress lives only in this browser; export is the only way to move or back it up. */
/**
 * `busy` is true while an import or reset is still being applied; another can't start until it has finished.
 * `onReplacing` returns a token for the replacement, which is handed back to `onChanged` when it finishes.
 */
/** `revision` changes whenever this view saves something or reloads after a replacement, so "Last saved" follows it. */
/** `course` is the course total, shown here on every screen size (the header drops its counter on phones). */
export function ProgressPanel({ store, busy, onReplacing, onChanged, onClose, revision = "", course }: { store: ProgressStore; busy: boolean; onReplacing: () => number; onChanged: (token: number) => void; onClose: () => void; revision?: string; course?: { completed: number; total: number } }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [saved, setSaved] = useState<string | null | undefined>(undefined); // undefined while reading
  // Only the newest read may update the line, so a slow older read can't overwrite a newer answer.
  const readNo = useRef(0);
  const refreshSaved = () => {
    const n = ++readNo.current;
    store.exportAll().then((d) => { if (n === readNo.current) setSaved(lastSaved(d)); }, () => { if (n === readNo.current) setSaved(undefined); });
  };
  useEffect(refreshSaved, [store, revision]);

  // Keyboard users land in the panel when it opens and return to whatever opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);

  const doExport = async () => {
    const data = await store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `python-intelligence-progress-${data.exportedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setMsg({ ok: true, text: `Exported ${data.lessons.length} lesson record(s) and ${Object.keys(data.drafts).length} draft(s).` });
  };

  const doImport = async (f: File) => {
    // Marked busy before anything else is awaited, so a second import or a reset can't start alongside this one.
    const token = onReplacing(); // also before storage changes, so a run still in flight can't write into the replacement
    try {
      await store.importAll(JSON.parse(await f.text()));
      setMsg({ ok: true, text: "Progress imported." });
    } catch (e) {
      setMsg({ ok: false, text: `Import failed, and your current progress was left unchanged. ${(e as Error).message}` });
    } finally {
      onChanged(token); // even after a rejected import: reload (unchanged) storage and catch the views up
      refreshSaved();
    }
  };

  return (
    <div className="panel" role="dialog" aria-modal="false" aria-labelledby="pp-title"
         onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <h2 id="pp-title" ref={heading} tabIndex={-1}>Your progress</h2>
      <p>Your progress is saved in <strong>this browser only</strong>. Nothing is sent to a server. To move it to another
         device, or to back it up, export it to a file and import that file elsewhere.</p>
      {course && <p className="course-total">Lessons completed: <strong>{course.completed} of {course.total}</strong></p>}
      <p className="saved-at">{saved === undefined ? "Checking what is saved…" : saved === null ? "Nothing saved yet."
        : <>Last saved: <time dateTime={saved}>{new Date(saved).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>. Code you type is saved as you go.</>}</p>
      <div className="run-bar">
        <button type="button" className="btn primary" onClick={doExport}>Export progress</button>
        <button type="button" className="btn" onClick={() => file.current?.click()} disabled={busy}>Import from file…</button>
        <input ref={file} type="file" accept="application/json,.json" hidden disabled={busy}
               onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ""; }} />
        {!confirmReset ? (
          <button type="button" className="btn danger" onClick={() => setConfirmReset(true)} disabled={busy}>Reset…</button>
        ) : (
          <span className="confirm">This erases all progress and drafts in this browser.{" "}
            <button type="button" className="btn danger" disabled={busy} onClick={async () => { const token = onReplacing(); try { await store.clear(); } finally { onChanged(token); refreshSaved(); } setConfirmReset(false); setMsg({ ok: true, text: "Progress reset." }); }}>Erase everything</button>{" "}
            <button type="button" className="btn ghost" onClick={() => setConfirmReset(false)}>Cancel</button>
          </span>
        )}
      </div>
      {msg && <p role="status" className={msg.ok ? "pill ok" : "pill bad"}>{msg.text}</p>}
      <button type="button" className="btn ghost close" onClick={onClose}>Close</button>
    </div>
  );
}
