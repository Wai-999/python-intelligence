import { useCallback, useEffect, useMemo, useState } from "react";
import { CurriculumMap } from "./components/CurriculumMap";
import { LessonView } from "./components/LessonView";
import { Library } from "./components/Library";
import { ProgressPanel } from "./components/ProgressPanel";
import { ReviewView } from "./components/ReviewView";
import { buildModel, dueReviews, type LearnerEvent } from "./learner/model";
import { exerciseEvents, quizEvents, reviewEvent, reviewItem, type Stamp } from "./learner/record";
import { isExercise } from "./content/types";
import { LESSONS } from "./content/lessons";
import { buildGraph, isUnlocked, recommendNext, type ProgressMap } from "./curriculum/graph";
import { getRunner } from "./py/runner";
import { waitForController } from "./sw-register";
import { applyOutcome, visitStep } from "./progress/logic";
import { openProgressStore } from "./progress/store";
import type { LessonProgress, ProgressStore } from "./progress/types";

const graph = buildGraph(LESSONS);

type Route = { view: "home" } | { view: "library" } | { view: "review" } | { view: "lesson"; lessonId: string; step: number };

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const stampNow = (): Stamp => ({ at: new Date().toISOString(), id: newId });

function parseHash(h: string): Route {
  const m = /^#\/lesson\/([\w-]+)(?:\/(\d+))?/.exec(h);
  if (m && graph.byId.has(m[1]!)) {
    const max = graph.byId.get(m[1]!)!.steps.length - 1;
    return { view: "lesson", lessonId: m[1]!, step: Math.min(max, Number(m[2] ?? 0)) };
  }
  if (/^#\/library\/?$/.test(h)) return { view: "library" };
  if (/^#\/review\/?$/.test(h)) return { view: "review" };
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
  const [events, setEvents] = useState<LearnerEvent[]>([]);
  const [assist, setAssist] = useState<Record<string, number>>({});
  const [generation, setGeneration] = useState(0);
  // "Now" for the review schedule: re-read at the next review deadline, and whenever the window regains focus.
  const [now, setNow] = useState(() => new Date().toISOString());

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
    setEvents(exp.events);
    setAssist(exp.assistance);
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
    // Warm Python once the service worker controls the page, so a first visit also caches Pyodide for offline use.
    if (lesson.steps.some((s) => s.kind === "example" || s.kind === "guided" || s.kind === "challenge"))
      void waitForController().then(() => getRunner().warm()).catch(() => {});
  }, [route, store]); // eslint-disable-line react-hooks/exhaustive-deps

  // Learner events: kept in memory for the model and appended to IndexedDB (the store validates them).
  const record = useCallback((evs: LearnerEvent[]) => {
    if (evs.length === 0) return;
    setEvents((prev) => [...prev, ...evs]);
    void store?.appendEvents(evs).catch((e) => setStoreError(String(e?.message ?? e)));
  }, [store]);
  const model = useMemo(() => buildModel(LESSONS, events), [events]);
  useEffect(() => {
    const tick = () => setNow(new Date().toISOString());
    const nowMs = Date.now();
    const next = [...model.concepts.values()].map((c) => (c.reviewDue ? Date.parse(c.reviewDue) : Infinity)).filter((t) => t > nowMs)
      .reduce((a, b) => Math.min(a, b), Infinity);
    // Browsers cap timer delays at about 24.8 days; a capped timer just re-arms this effect.
    const timer = Number.isFinite(next) ? setTimeout(tick, Math.min(next - nowMs + 50, 2 ** 31 - 1)) : undefined;
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); removeEventListener("focus", tick); document.removeEventListener("visibilitychange", onVisible); };
  }, [model, now]);
  useEffect(() => { setNow(new Date().toISOString()); }, [route, events]);
  const dueCount = dueReviews(model, now).filter((s) => reviewItem(LESSONS, s.concept, 0) !== null).length;

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
          <a className="btn ghost" href="#/library" aria-current={route.view === "library" ? "page" : undefined}>Library</a>
          <a className="btn ghost" href="#/review" aria-current={route.view === "review" ? "page" : undefined}>
            Review{dueCount > 0 && <> <span className="badge" aria-label={`${dueCount} due`}>{dueCount}</span></>}
          </a>
          <span className="overall" aria-label={`${completed} of ${LESSONS.length} lessons completed`}>
            <span className="bar"><span style={{ width: `${(completed / LESSONS.length) * 100}%` }} /></span>
            {completed}/{LESSONS.length}
          </span>
          <button type="button" className="btn ghost" onClick={() => setPanel((x) => !x)} aria-expanded={panel} disabled={!store}>Progress</button>
        </div>
      </header>
      {storeError && <p className="pill bad" role="alert">Progress can't be saved in this browser ({storeError}). Private browsing modes often block storage.</p>}
      {panel && store && <ProgressPanel store={store} onChanged={() => { void reload(store).then(() => setGeneration((g) => g + 1)); }} onClose={() => setPanel(false)} />}

      <div className={`layout layout--${route.view}`}>
        {route.view === "lesson" && (
          <aside className="side"><CurriculumMap compact graph={graph} progress={progress} recommendation={rec} currentId={current} go={go} /></aside>
        )}
        <main id="main" tabIndex={-1}>
          {!ready ? <p className="muted">Loading your progress…</p> : route.view === "library" ? <Library /> : route.view === "review" ? (
            <ReviewView lessons={LESSONS} model={model} events={events} now={now} titleOf={titleOf}
                        onAnswer={(item, correct) => record([reviewEvent(item, correct, stampNow())])} />
          ) : route.view === "home" ? (
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
              generation={generation}
              assistance={Object.fromEntries(Object.entries(assist).filter(([k]) => k.startsWith(`${route.lessonId}:`)).map(([k, v]) => [k.slice(route.lessonId.length + 1), v]))}
              onAssist={(sid, level) => {
                const key = `${route.lessonId}:${sid}`;
                setAssist((a) => ({ ...a, [key]: Math.max(a[key] ?? 0, level) }));
                void store?.raiseAssistance(route.lessonId, sid, level).catch((e) => setStoreError(String(e?.message ?? e)));
              }}
              onDraft={(sid, code) => {
                setDrafts((d) => ({ ...d, [route.lessonId]: { ...d[route.lessonId], [sid]: code } }));
                void store?.putDraft(route.lessonId, sid, code);
              }}
              onExercise={(sid, passed, failedConcepts, detail) => {
                const l = graph.byId.get(route.lessonId)!;
                void save(applyOutcome(l, progress.get(l.id), sid, { passed, failedConcepts, attempt: true }));
                const step = l.steps.find((s) => s.id === sid);
                if (step && isExercise(step)) record(exerciseEvents(l, step, detail.results, detail.assistance, stampNow()));
              }}
              onQuiz={(sid, score, passed, missed, correct) => {
                const l = graph.byId.get(route.lessonId)!;
                void save(applyOutcome(l, progress.get(l.id), sid, { passed, score, failedConcepts: missed, attempt: true }));
                const step = l.steps.find((s) => s.id === sid);
                if (step?.kind === "quiz") record(quizEvents(l, step, correct, stampNow()));
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
