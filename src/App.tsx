import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CurriculumMap } from "./components/CurriculumMap";
import { LessonView } from "./components/LessonView";
import { Library } from "./components/Library";
import { ProgressPanel } from "./components/ProgressPanel";
import { ReviewView } from "./components/ReviewView";
import { buildModel, dueReviews, type Assistance, type LearnerEvent } from "./learner/model";
import { creditedConcepts, exerciseEvents, quizEvents, reviewEvent, reviewItem, suggestedTier, type Stamp } from "./learner/record";
import { interventionEvent, mesoTrigger, transferTarget, type Intervention, type Target } from "./learner/loop";
import { MesoPanel } from "./components/MesoPanel";
import { isExercise, type Lesson } from "./content/types";
import { LESSONS } from "./content/lessons";
import { buildGraph, isUnlocked, recommendNext, type ProgressMap } from "./curriculum/graph";
import { getRunner } from "./py/runner";
import { waitForController } from "./sw-register";
import { applyOutcome, visitStep } from "./progress/logic";
import { groupDrafts } from "./progress/drafts";
import { openProgressStore, StaleProgressError } from "./progress/store";
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

/** Tabs tell each other here that progress was imported or reset, so they reload instead of showing stale progress. */
const PROGRESS_CHANNEL = "python-intelligence-progress";

/** The help level assumed when the stored one can't be read: the most help, so no attempt is over-credited. */
const UNKNOWN_HELP = 4;

export function App() {
  const [store, setStore] = useState<ProgressStore | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressMap>(new Map());
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [panel, setPanel] = useState(false);
  const [ready, setReady] = useState(false);
  const [events, setEvents] = useState<LearnerEvent[]>([]);
  // The same events, updated synchronously as they are recorded, so the feedback controller sees the run just made.
  const eventsRef = useRef<LearnerEvent[]>([]);
  // A meso-loop step back for one task (lesson:step:generation), shown after the tutor note.
  const [meso, setMeso] = useState<{ id: string; key: string; i: Intervention; target: Target | null } | null>(null);
  // The route on screen right now (a run can finish after the learner has moved on).
  const routeRef = useRef(route);
  routeRef.current = route;
  const [assist, setAssist] = useState<Record<string, number>>({});
  const [generation, setGeneration] = useState(0);
  // Bumped synchronously when an import or reset starts; results of runs started earlier are then ignored.
  // It starts one ahead of `generation`: the first read of saved progress counts as a replacement, so nothing
  // (not even recording a visit) can write before what is already saved has been read.
  const generationRef = useRef(1);
  // While an import or reset is being applied, the page is inert and any input that slips through is dropped:
  // `live()` is false from the moment the replacement starts until the views have been rebuilt from it.
  const [replacing, setReplacing] = useState(true);
  // Set when reading progress back (on start, or after a replacement) failed: the page stays locked until a retry succeeds.
  const [reloadFailed, setReloadFailed] = useState<{ token: number; message: string } | null>(null);
  const live = () => generation === generationRef.current;
  // "Now" for the review schedule: re-read at the next review deadline, and whenever the window regains focus.
  const [now, setNow] = useState(() => new Date().toISOString());

  // One exportAll (a single read transaction) gives a consistent snapshot of lessons, drafts, events and help; it is
  // published only if every step succeeded, so the views never mix old and new state.
  const reload = useCallback(async (s: ProgressStore) => {
    const exp = await s.load(); // also binds this view's writes to the snapshot's replacement token
    const all = exp.lessons;
    const d = groupDrafts(exp.drafts);
    // Quizzes attempted before help was tracked (a version 1 file, an upgraded database) have shown their answers.
    const assistance = { ...exp.assistance };
    for (const p of all) {
      const lesson = graph.byId.get(p.lessonId);
      for (const step of lesson?.steps ?? []) {
        const key = `${p.lessonId}:${step.id}`;
        if (step.kind === "quiz" && (p.steps[step.id]?.attempts ?? 0) > 0 && (assistance[key] ?? 0) < 4) {
          assistance[key] = 4;
          await s.raiseAssistance(p.lessonId, step.id, 4);
        }
      }
    }
    setProgress(new Map(all.map((p) => [p.lessonId, p])));
    setDrafts(d);
    setEvents(exp.events);
    eventsRef.current = exp.events;
    setAssist(assistance);
    return exp.position;
  }, []);

  // Until the first load has succeeded (or a retry of it has), another tab's replacement can't reload this view yet:
  // it is noted, and the read repeats until one completes with no replacement announced meanwhile.
  const readUntilQuiet = async (s: ProgressStore) => {
    let pos;
    do {
      remoteDuringLoad.current = false;
      pos = await reload(s);
    } while (!firstLoadDone.current && remoteDuringLoad.current);
    return pos;
  };

  // Open storage; resume at the exact saved position if the URL doesn't name one.
  useEffect(() => {
    openProgressStore().then(async (s) => {
      setStore(s);
      try {
        const pos = await readUntilQuiet(s);
        firstLoadDone.current = true;
        if (!location.hash && pos && graph.byId.has(pos.lessonId)) location.replace(`#/lesson/${pos.lessonId}/${pos.stepIndex}`);
        setGeneration(1);
        setReplacing(false);
      } catch (e) {
        // Storage opened but couldn't be read: stay locked (so nothing overwrites it) and offer a retry.
        setReloadFailed({ token: 1, message: String((e as Error)?.message ?? e) });
      }
      setReady(true);
    }).catch((e) => {
      // No storage at all (e.g. some private modes): the site still works, it just can't save.
      setStoreError(String(e?.message ?? e));
      setGeneration(1);
      setReplacing(false);
      setReady(true);
    });
  }, [reload]);

  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  // A write refused because another tab replaced the progress means this view is stale: reload it like a replacement.
  // Any other storage failure is reported.
  const failRef = useRef<(e: unknown) => void>(() => {});
  const fail = useCallback((e: unknown) => failRef.current(e), []);
  const remoteRef = useRef<() => void>(() => {});
  // A replacement announced while the first load is still reading: the load reads again before unlocking the page.
  const remoteDuringLoad = useRef(false);
  // Set in the same synchronous step that unlocks the page after the first load, so no broadcast falls between.
  const firstLoadDone = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(PROGRESS_CHANNEL);
    ch.onmessage = (m) => { if (m.data === "replaced") remoteRef.current(); };
    channel.current = ch;
    return () => { ch.close(); channel.current = null; };
  }, []);

  const save = useCallback(async (p: LessonProgress) => {
    setProgress((m) => new Map(m).set(p.lessonId, p));
    await store?.putLesson(p).catch(fail);
  }, [store, fail]);

  // Track position + furthest step whenever the visible step changes. Not while an import or reset is being applied:
  // the visit is applied to the reloaded progress instead, once `generation` catches up.
  useEffect(() => {
    if (route.view !== "lesson" || !store || !live()) return;
    const lesson = graph.byId.get(route.lessonId)!;
    void store.setPosition(route.lessonId, route.step).catch(fail);
    const prev = progress.get(route.lessonId);
    const next = visitStep(lesson, prev, route.step);
    if (!prev || next.furthestStep !== prev.furthestStep) void save(next);
    // Warm Python once the service worker controls the page, so a first visit also caches Pyodide for offline use.
    if (lesson.steps.some((s) => s.kind === "example" || isExercise(s)))
      void waitForController().then(() => getRunner().warm()).catch(() => {});
  }, [route, store, generation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Learner events: kept in memory for the model and appended to IndexedDB (the store validates them).
  const record = useCallback((evs: LearnerEvent[]) => {
    if (evs.length === 0) return;
    setEvents((prev) => [...prev, ...evs]);
    eventsRef.current = [...eventsRef.current, ...evs];
    void store?.appendEvents(evs).catch(fail);
  }, [store, fail]);
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
  useEffect(() => { setMeso(null); }, [route]); // a step back belongs to the task on screen
  const dueCount = dueReviews(model, now).filter((s) => reviewItem(LESSONS, s.concept, 0) !== null).length;

  // Only the latest replacement unlocks the page, and only once its reload has succeeded.
  const finishReplacement = (token: number) => {
    if (!store) return;
    setReloadFailed(null);
    readUntilQuiet(store).then(() => {
      if (token !== generationRef.current) return;
      firstLoadDone.current = true; // also when a failed first load succeeds on retry
      setGeneration(token);
      setReplacing(false);
    }, (e) => {
      if (token !== generationRef.current) return;
      setReloadFailed({ token, message: String(e?.message ?? e) });
    });
  };

  // Another tab imported or reset progress (told by its broadcast, or found when one of our writes was refused).
  remoteRef.current = () => {
    if (!firstLoadDone.current) { remoteDuringLoad.current = true; return; } // the first load is still running: it re-reads
    generationRef.current += 1;
    setReplacing(true);
    finishReplacement(generationRef.current);
  };
  failRef.current = (e) => {
    if (e instanceof StaleProgressError) remoteRef.current();
    else setStoreError(String((e as Error)?.message ?? e));
  };

  // Double loop: after recording an attempt, step back once if the controller says so (repeated structural errors, an
  // explanation mismatch, reliance on strong hints), but only while the task is still on screen, so a step back is
  // logged as shown only when it really is.
  const stepBack = (l: Lesson, sid: string, concepts: string[], atMs: number) => {
    const here = routeRef.current;
    if (here.view !== "lesson" || here.lessonId !== l.id || l.steps[here.step]?.id !== sid) return;
    for (const c of concepts) {
      const i = mesoTrigger(eventsRef.current, c, atMs, `${l.id}:${sid}`);
      if (!i) continue;
      const shown = interventionEvent(i, l.id, sid, "shown", stampNow());
      setMeso({ id: shown.id, key: `${l.id}:${sid}:${generationRef.current}`, i, target: transferTarget(LESSONS, model, c, l.id, sid, assist) });
      record([shown]);
      break;
    }
  };

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
      {reloadFailed && <p className="pill bad" role="alert">Your saved progress couldn't be read back: {reloadFailed.message}. The page is paused so
        nothing overwrites it.{" "}<button type="button" className="btn" onClick={() => finishReplacement(reloadFailed.token)}>Try loading it again</button></p>}
      {panel && store && <ProgressPanel store={store} busy={replacing} onReplacing={() => { generationRef.current += 1; setReplacing(true); return generationRef.current; }}
                                  onChanged={(token) => { channel.current?.postMessage("replaced"); finishReplacement(token); }}
                                  onClose={() => setPanel(false)} />}

      <div className={`layout layout--${route.view}`} inert={replacing}>
        {route.view === "lesson" && (
          <aside className="side"><CurriculumMap compact graph={graph} progress={progress} recommendation={rec} currentId={current} go={go} /></aside>
        )}
        <main id="main" tabIndex={-1} aria-busy={replacing}>
          {!ready ? <p className="muted">Loading your progress…</p> : route.view === "library" ? <Library /> : route.view === "review" ? (
            <ReviewView key={generation} lessons={LESSONS} model={model} events={events} now={now} titleOf={titleOf}
                        onAnswer={(item, correct) => { if (live()) record([reviewEvent(item, correct, stampNow())]); }} />
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
              suggestTier={(step) => suggestedTier(model, graph.byId.get(route.lessonId)!, step)}
              mesoFor={(sid) => meso && meso.key === `${route.lessonId}:${sid}:${generation}` ? (
                <MesoPanel key={meso.id} intervention={meso.i} target={meso.target} titleOf={titleOf} onOutcome={(outcome) => {
                  if (!live()) return;
                  record([interventionEvent(meso.i, route.lessonId, sid, outcome, stampNow())]);
                  if (outcome === "postponed") setMeso(null);
                }} />
              ) : undefined}
              assistance={Object.fromEntries(Object.entries(assist).filter(([k]) => k.startsWith(`${route.lessonId}:`)).map(([k, v]) => [k.slice(route.lessonId.length + 1), v]))}
              onAssist={(sid, level) => {
                if (!live()) return;
                const key = `${route.lessonId}:${sid}`;
                setAssist((a) => ({ ...a, [key]: Math.max(a[key] ?? 0, level) }));
                void store?.raiseAssistance(route.lessonId, sid, level).catch(fail);
              }}
              onDraft={(sid, code) => {
                if (!live()) return;
                setDrafts((d) => ({ ...d, [route.lessonId]: { ...d[route.lessonId], [sid]: code } }));
                void store?.putDraft(route.lessonId, sid, code).catch(fail);
              }}
              onExercise={(sid, passed, failedConcepts, detail) => {
                if (detail.generation !== generationRef.current) return; // started before an import or reset
                const l = graph.byId.get(route.lessonId)!;
                void save(applyOutcome(l, progress.get(l.id), sid, { passed, failedConcepts, attempt: true }));
                const step = l.steps.find((s) => s.id === sid);
                // Another tab may have revealed help on this task: count the higher of this tab's and the stored level.
                // Without storage (some private modes) practice is still modelled for this visit, from this tab's help alone.
                // If the stored level can't be read, another tab may have shown the solution: the attempt is kept, but
                // conservatively counted as fully assisted (UNKNOWN_HELP), so it never passes for independent work.
                const stamp = stampNow(); // the attempt's own time, not when the help level was read back
                if (step && isExercise(step)) void (store ? store.getAssistance(l.id, sid) : Promise.resolve(0))
                  .catch((e) => { fail(e); return UNKNOWN_HELP; })
                  .then((stored) => {
                    if (detail.generation !== generationRef.current) return;
                    record(exerciseEvents(l, step, detail.results, Math.max(detail.assistance, stored) as Assistance, stamp, detail.errorTags));
                    stepBack(l, sid, creditedConcepts(l, step), Date.parse(stamp.at));
                  });
              }}
              onQuiz={(sid, score, passed, missed, correct) => {
                if (!live()) return; // submitted while an import or reset was being applied
                const l = graph.byId.get(route.lessonId)!;
                void save(applyOutcome(l, progress.get(l.id), sid, { passed, score, failedConcepts: missed, attempt: true }));
                const step = l.steps.find((s) => s.id === sid);
                if (step?.kind === "quiz") {
                  // Submitting reveals every correct answer, so later submissions of this quiz count as assisted. The store
                  // raises the level and returns the previous one in one transaction, so two open tabs can't both count as unaided.
                  const key = `${l.id}:${sid}`;
                  const stamp = stampNow();
                  const startedIn = generation;
                  setAssist((a) => ({ ...a, [key]: 4 }));
                  const shownHere = assist[key] ?? 0;
                  void (store ? store.raiseAssistance(l.id, sid, 4) : Promise.resolve(shownHere))
                    // The previous level is unknown if storage failed: keep the attempt, counted as assisted (see UNKNOWN_HELP).
                    .catch((e) => { fail(e); return UNKNOWN_HELP; })
                    .then((before) => {
                      if (startedIn !== generationRef.current) return; // progress was replaced meanwhile
                      // This tab's own record counts too: a reveal whose save failed still happened.
                      const evs = quizEvents(l, step, correct, stamp, Math.max(before, shownHere) >= 4 ? 4 : 0);
                      record(evs);
                      stepBack(l, sid, [...new Set(evs.map((e) => e.concept))], Date.parse(stamp.at)); // e.g. an explanation mismatch
                    })
                    .catch(fail);
                }
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
