import { useCallback, useEffect, useMemo, useState } from "react";
import { CurriculumMap } from "./components/CurriculumMap";
import { LessonView } from "./components/LessonView";
import { ProgressPanel } from "./components/ProgressPanel";
import { LESSONS } from "./content/lessons";
import { buildGraph, isUnlocked, recommendNext, type ProgressMap } from "./curriculum/graph";
import { getRunner } from "./py/runner";
import { applyOutcome, visitStep } from "./progress/logic";
import { openProgressStore } from "./progress/store";
import type { LessonProgress, ProgressStore } from "./progress/types";

const graph = buildGraph(LESSONS);

type Route = { view: "home" } | { view: "lesson"; lessonId: string; step: number };

function parseHash(h: string): Route {
  const m = /^#\/lesson\/([\w-]+)(?:\/(\d+))?/.exec(h);
  if (m && graph.byId.has(m[1]!)) {
    const max = graph.byId.get(m[1]!)!.steps.length - 1;
    return { view: "lesson", lessonId: m[1]!, step: Math.min(max, Number(m[2] ?? 0)) };
  }
  return { view: "home" };
}

export function App() {
  const [store, setStore] = useState<ProgressStore | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressMap>(new Map());
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [panel, setPanel] = useState(false);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async (s: ProgressStore) => {
    const all = await s.allLessons();
    setProgress(new Map(all.map((p) => [p.lessonId, p])));
    const exp = await s.exportAll();
    const d: Record<string, Record<string, string>> = {};
    for (const [k, v] of Object.entries(exp.drafts)) {
      const [lid, sid] = k.split(":") as [string, string];
      (d[lid] ??= {})[sid] = v;
    }
    setDrafts(d);
    return exp.position;
  }, []);

  // Open storage; resume at the exact saved position if the URL doesn't name one.
  useEffect(() => {
    openProgressStore().then(async (s) => {
      setStore(s);
      const pos = await reload(s);
      if (!location.hash && pos && graph.byId.has(pos.lessonId)) location.replace(`#/lesson/${pos.lessonId}/${pos.stepIndex}`);
      setReady(true);
    }).catch((e) => { setStoreError(String(e?.message ?? e)); setReady(true); });
  }, [reload]);

  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  const save = useCallback(async (p: LessonProgress) => {
    setProgress((m) => new Map(m).set(p.lessonId, p));
    await store?.putLesson(p);
  }, [store]);

  // Track position + furthest step whenever the visible step changes.
  useEffect(() => {
    if (route.view !== "lesson" || !store) return;
    const lesson = graph.byId.get(route.lessonId)!;
    void store.setPosition(route.lessonId, route.step);
    const prev = progress.get(route.lessonId);
    const next = visitStep(lesson, prev, route.step);
    if (!prev || next.furthestStep !== prev.furthestStep) void save(next);
    if (lesson.steps.some((s) => s.kind === "example" || s.kind === "guided" || s.kind === "challenge")) void getRunner().warm().catch(() => {});
  }, [route, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (lessonId: string, step: number) => { location.hash = `#/lesson/${lessonId}/${step}`; };
  const current = route.view === "lesson" ? route.lessonId : undefined;
  const rec = useMemo(() => recommendNext(graph, progress, current), [progress, current]);
  const titleOf = (id: string) => graph.byId.get(id)?.title ?? id;
  const completed = [...progress.values()].filter((p) => p.completed).length;

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <a className="brand" href="#/"><span className="logo" aria-hidden="true">py</span> Python Intelligence</a>
        <div className="top-right">
          <span className="overall" aria-label={`${completed} of ${LESSONS.length} lessons completed`}>
            <span className="bar"><span style={{ width: `${(completed / LESSONS.length) * 100}%` }} /></span>
            {completed}/{LESSONS.length}
          </span>
          <button type="button" className="btn ghost" onClick={() => setPanel((x) => !x)} aria-expanded={panel} disabled={!store}>Progress</button>
        </div>
      </header>
      {storeError && <p className="pill bad" role="alert">Progress can't be saved in this browser ({storeError}). Private browsing modes often block storage.</p>}
      {panel && store && <ProgressPanel store={store} onChanged={() => void reload(store)} onClose={() => setPanel(false)} />}

      <div className={`layout layout--${route.view}`}>
        {route.view === "lesson" && (
          <aside className="side"><CurriculumMap compact graph={graph} progress={progress} recommendation={rec} currentId={current} go={go} /></aside>
        )}
        <main id="main" tabIndex={-1}>
          {!ready ? <p className="muted">Loading your progress…</p> : route.view === "home" ? (
            <>
              <section className="hero">
                <h1>Learn Python by running it.</h1>
                <p>Short lessons that build on one another: a motivating problem, an intuition, a visual walkthrough,
                   the precise rules, runnable code, and practice that is checked as you go. Python runs right here in your
                   browser, with nothing to install.</p>
              </section>
              <CurriculumMap graph={graph} progress={progress} recommendation={rec} go={go} />
              <p className="fineprint">The tutor on this site is an <strong>offline guide</strong>: pre-written explanations and
                 questions matched to your results, not a generative AI. Code runs in a sandboxed browser worker. Don't paste
                 secrets into it.</p>
            </>
          ) : (
            <LessonView
              lesson={graph.byId.get(route.lessonId)!}
              stepIndex={route.step}
              progress={progress.get(route.lessonId)}
              drafts={drafts[route.lessonId] ?? {}}
              recommendation={rec}
              unlocked={isUnlocked(graph, route.lessonId, progress)}
              titleOf={titleOf}
              go={go}
              onDraft={(sid, code) => {
                setDrafts((d) => ({ ...d, [route.lessonId]: { ...d[route.lessonId], [sid]: code } }));
                void store?.putDraft(route.lessonId, sid, code);
              }}
              onExercise={(sid, passed, failedConcepts) => {
                const l = graph.byId.get(route.lessonId)!;
                void save(applyOutcome(l, progress.get(l.id), sid, { passed, failedConcepts, attempt: true }));
              }}
              onQuiz={(sid, score, passed, missed) => {
                const l = graph.byId.get(route.lessonId)!;
                void save(applyOutcome(l, progress.get(l.id), sid, { passed, score, failedConcepts: missed, attempt: true }));
              }}
            />
          )}
        </main>
      </div>
      <footer className="foot">
        <p>Python Intelligence · lessons are original works · Python by <a href="https://pyodide.org/">Pyodide</a> {""}
           (CPython 3.12 compiled to WebAssembly)</p>
      </footer>
    </div>
  );
}
