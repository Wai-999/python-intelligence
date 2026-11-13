import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModel, type LearnerEvent } from "./learner/model";
import { quizEvents } from "./learner/record";
import type { Lesson, QuizStep } from "./content/types";
import type { LessonProgress, ProgressExport, ProgressStore } from "./progress/types";

// A deterministic race: the quiz's raiseAssistance stays pending while progress is reset, then resolves.
// Nothing from before the reset may reach memory or storage.

let release: (before: number) => void = () => {};
const appended: LearnerEvent[] = [];
const saved: string[] = [];
let raised = 0;
const pendingImports: (() => void)[] = [];
const finishImport = () => pendingImports.shift()?.();
let positions = 0;
let history: LearnerEvent[] = [];
let drafts: Record<string, string> = {};
let failExport = false;
let lessonsAfter: LessonProgress[] = [];
let staleLessons: LessonProgress[] = [];
const savedRecords: LessonProgress[] = [];
let exportGate: Promise<void> | null = null;
const fake: ProgressStore & { close(): void } = {
  close: () => {},
  getLesson: async () => undefined,
  allLessons: async () => staleLessons, // not used by the app: exportAll's single transaction is the source of truth
  putLesson: async (p) => { saved.push(p.lessonId); savedRecords.push(p); },
  getDraft: async () => undefined,
  putDraft: async () => {},
  getPosition: async () => null,
  setPosition: async () => { positions += 1; },
  appendEvents: async (evs) => { appended.push(...evs); },
  allEvents: async () => [],
  getAssistance: async () => 0,
  raiseAssistance: () => { raised += 1; return new Promise<number>((resolve) => { release = resolve; }); },
  exportAll: async (): Promise<ProgressExport> => {
    if (exportGate) await exportGate;
    if (failExport) throw new Error("disk went away");
    return { format: "python-intelligence-progress", version: 2, exportedAt: new Date().toISOString(),
    lessons: lessonsAfter, drafts, position: null, events: history, assistance: {} };
  },
  importAll: () => new Promise<void>((resolve) => { pendingImports.push(resolve); }),
  clear: async () => {},
};
let openFails = false;
vi.mock("./progress/store", () => ({ openProgressStore: async () => { if (openFails) throw new Error("storage blocked"); return fake; } }));
// Python runs report every check passed, tagged with the concepts of the step's own tests.
let runTests: { name: string; concept?: string }[] = [];
vi.mock("./py/runner", () => ({ getRunner: () => ({ status: "ready", onStatus: () => () => {}, warm: async () => {},
  run: async () => ({ ok: true, stdout: "", stderr: "", durationMs: 1, tests: runTests.map((t) => ({ ...t, passed: true, message: "" })) }) }) }));
vi.mock("./sw-register", () => ({ waitForController: () => new Promise(() => {}) }));

afterEach(() => { cleanup(); appended.length = 0; saved.length = 0; raised = 0; positions = 0; history = []; pendingImports.length = 0; drafts = {}; failExport = false; lessonsAfter = []; savedRecords.length = 0; exportGate = null; openFails = false; staleLessons = []; });

/** Opens the Progress panel and starts an import whose storage write stays pending until finishImport(). */
async function startImport() {
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));
  const file = new File([JSON.stringify({ format: "python-intelligence-progress", version: 2 })], "p.json", { type: "application/json" });
  fireEvent.change(document.querySelector("input[type=file]")!, { target: { files: [file] } });
  await waitFor(() => expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(true));
}

async function openQuiz() {
  const { App } = await import("./App");
  const lesson = (await import("../content/lessons/py-values-names.json")).default as unknown as { steps: { kind: string; questions?: { answer: number }[] }[] };
  const at = lesson.steps.findIndex((s) => s.kind === "quiz");
  location.hash = `#/lesson/py-values-names/${at}`;
  render(<App />);
  await screen.findByRole("button", { name: "Check answers" });
  const sets = document.querySelectorAll("fieldset.question");
  lesson.steps[at]!.questions!.forEach((q, i) => fireEvent.click(sets[i]!.querySelectorAll("input[type=radio]")[q.answer]!));
}

describe("App", () => {
  it("drops a quiz result whose storage write finishes after a reset", async () => {
    await openQuiz();
    fireEvent.click(screen.getByRole("button", { name: "Check answers" }));
    await screen.findByText(/Passed!/);

    fireEvent.click(screen.getByRole("button", { name: "Progress" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset…" }));
    fireEvent.click(screen.getByRole("button", { name: "Erase everything" }));
    await screen.findByText("Progress reset.");

    await act(async () => { release(0); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));
    expect(appended).toEqual([]);
    location.hash = "#/review";
    await waitFor(() => expect(screen.getByText(/Concepts appear here once you start practising them/)).toBeTruthy());
  });

  it("ignores a quiz submitted while an import is being applied, and makes the page inert meanwhile", async () => {
    await openQuiz();
    await startImport();
    const before = saved.length;
    fireEvent.click(screen.getByRole("button", { name: "Check answers" })); // inert doesn't stop a synthetic click
    await new Promise((r) => setTimeout(r, 20));
    expect(saved.length).toBe(before);
    expect(raised).toBe(0);
    expect(appended).toEqual([]);
    await act(async () => { finishImport(); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(false));
    expect(appended).toEqual([]);
  });

  it("doesn't record a visit while an import is pending, can't start a second one, and applies the visit afterwards", async () => {
    await openQuiz();
    await waitFor(() => expect(positions).toBeGreaterThan(0));
    await startImport();
    const [pos, kept] = [positions, saved.length];
    expect((screen.getByRole("button", { name: "Import from file…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { location.hash = "#/lesson/py-functions/1"; dispatchEvent(new HashChangeEvent("hashchange")); });
    await new Promise((r) => setTimeout(r, 20));
    expect(positions).toBe(pos);
    expect(saved.length).toBe(kept);
    await act(async () => { finishImport(); await Promise.resolve(); });
    await waitFor(() => expect(positions).toBe(pos + 1)); // the visit lands on the reloaded progress
    expect((screen.getByRole("button", { name: "Import from file…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores a review answered while an import is pending", async () => {
    const at = new Date(Date.now() - 48 * 3600_000).toISOString();
    history = [["a", "exercise"], ["b", "exercise"], ["check", "quiz"]].map(([stepId, task], i) => ({ id: `h${i}`, at, lessonId: "py-values-names",
      stepId: stepId!, task: task as LearnerEvent["task"], concept: "names", passed: true, assistance: 0, policy: "learner-heuristic-1" }));
    const { App } = await import("./App");
    location.hash = "#/review";
    render(<App />);
    const form = await waitFor(() => { const f = document.querySelector("form.quiz"); expect(f).toBeTruthy(); return f!; });
    fireEvent.click(form.querySelector("input[type=radio]")!);
    await startImport();
    fireEvent.click(screen.getByRole("button", { name: "Check answer" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(appended).toEqual([]);
    await act(async () => { finishImport(); await Promise.resolve(); });
  });

  it("keeps the page locked until the latest of two overlapping imports has finished", async () => {
    await openQuiz();
    await startImport();
    // A second change event (the disabled input stops real users; a synthetic event gets through).
    const file = new File([JSON.stringify({ format: "python-intelligence-progress", version: 2 })], "q.json", { type: "application/json" });
    fireEvent.change(document.querySelector("input[type=file]")!, { target: { files: [file] } });
    await waitFor(() => expect(pendingImports.length).toBe(2));
    await act(async () => { finishImport(); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(true); // the earlier one can't unlock it
    await act(async () => { finishImport(); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(false));
  });

  it("shows the imported drafts and practice once the import has been read back", async () => {
    await openQuiz();
    await startImport();
    const at = new Date(Date.now() - 3600_000).toISOString();
    history = [{ id: "i1", at, lessonId: "py-values-names", stepId: "a", task: "exercise", concept: "names", passed: true, assistance: 0, policy: "learner-heuristic-1" }];
    drafts = { "py-values-names:circle": "radius = 'from the backup'\n" };
    await act(async () => { finishImport(); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(false));
    const lesson = (await import("../content/lessons/py-values-names.json")).default as unknown as { steps: { id: string }[] };
    await act(async () => { location.hash = `#/lesson/py-values-names/${lesson.steps.findIndex((s) => s.id === "circle")}`; dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(() => expect((document.querySelector("textarea.editor-input") as HTMLTextAreaElement).value).toBe("radius = 'from the backup'\n"));
    await act(async () => { location.hash = "#/review"; dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(() => expect(screen.getByRole("row", { name: /^names/ })).toBeTruthy());
  });

  it("keeps the page locked, with a retry, when the replaced progress can't be read back", async () => {
    await openQuiz();
    await startImport();
    failExport = true;
    lessonsAfter = [{ lessonId: "py-values-names", steps: {}, furthestStep: 0, completed: true, mastery: 1, struggles: {} } as unknown as LessonProgress];
    await act(async () => { finishImport(); await Promise.resolve(); });
    await screen.findByText(/couldn't be read back: disk went away/);
    // Nothing from the half-finished read is shown: the lesson list read succeeded, but it isn't published alone.
    expect(screen.getByLabelText(/lessons completed/).getAttribute("aria-label")).toMatch(/^0 of /);
    expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check answers" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(appended).toEqual([]);
    expect(raised).toBe(0);
    failExport = false;
    fireEvent.click(screen.getByRole("button", { name: "Try loading it again" }));
    await waitFor(() => expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(false));
    expect(screen.queryByText(/couldn't be read back/)).toBeNull();
    expect(screen.getByLabelText(/lessons completed/).getAttribute("aria-label")).toMatch(/^1 of /);
  });

  const completedRecord = () => ({ lessonId: "py-values-names", steps: {}, furthestStep: 9, completed: true, mastery: 1, struggles: {} }) as unknown as LessonProgress;

  it("writes nothing until saved progress has been read on start", async () => {
    lessonsAfter = [completedRecord()];
    let open: () => void = () => {};
    exportGate = new Promise((r) => { open = r; });
    const { App } = await import("./App");
    location.hash = "#/lesson/py-values-names/0";
    render(<App />);
    await new Promise((r) => setTimeout(r, 30));
    expect(positions).toBe(0);
    expect(saved).toEqual([]);
    await act(async () => { open(); await Promise.resolve(); });
    await waitFor(() => expect(positions).toBe(1));
    expect(savedRecords.every((p) => p.completed)).toBe(true); // the saved record is kept, not replaced by a fresh one
    expect(screen.getByLabelText(/lessons completed/).getAttribute("aria-label")).toMatch(/^1 of /);
  });

  it("stays paused with a retry when saved progress can't be read on start, and keeps the saved record", async () => {
    lessonsAfter = [completedRecord()];
    failExport = true;
    const { App } = await import("./App");
    location.hash = "#/lesson/py-values-names/0";
    render(<App />);
    await screen.findByText(/couldn't be read back: disk went away/);
    expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(true);
    expect(positions).toBe(0);
    expect(saved).toEqual([]);
    failExport = false;
    fireEvent.click(screen.getByRole("button", { name: "Try loading it again" }));
    await waitFor(() => expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(false));
    await waitFor(() => expect(positions).toBe(1));
    expect(savedRecords.every((p) => p.completed)).toBe(true);
    expect(screen.queryByText(/couldn't be read back/)).toBeNull();
  });

  it("still works, unsaved, when storage can't be opened at all", async () => {
    openFails = true;
    const { App } = await import("./App");
    location.hash = "#/lesson/py-values-names/0";
    render(<App />);
    await screen.findByText(/Progress can't be saved in this browser \(.*storage blocked\)/);
    expect(document.querySelector(".layout")!.hasAttribute("inert")).toBe(false);

    // Practice is still modelled for the visit: fail the quiz, then retry it (assisted, since its answers were shown).
    const lesson = (await import("../content/lessons/py-values-names.json")).default as unknown as Lesson;
    const at = lesson.steps.findIndex((st) => st.kind === "quiz");
    const quiz = lesson.steps[at] as QuizStep;
    const answer = async (right: boolean) => {
      await act(async () => { location.hash = `#/lesson/py-values-names/${at}`; dispatchEvent(new HashChangeEvent("hashchange")); });
      const sets = await waitFor(() => { const f = document.querySelectorAll("fieldset.question"); expect(f.length).toBe(quiz.questions.length); return f; });
      quiz.questions.forEach((q, i) => fireEvent.click(sets[i]!.querySelectorAll("input[type=radio]")[right ? q.answer : (q.answer + 1) % q.choices.length]!));
      fireEvent.click(screen.getByRole("button", { name: "Check answers" }));
      await screen.findByText(right ? /Passed!/ : /You need/);
      await new Promise((r) => setTimeout(r, 20));
    };
    await answer(false);
    await act(async () => { location.hash = "#/"; dispatchEvent(new HashChangeEvent("hashchange")); }); // remount the quiz
    await answer(true);
    await act(async () => { location.hash = "#/review"; dispatchEvent(new HashChangeEvent("hashchange")); });
    let n = 0;
    const stamp = { at: new Date().toISOString(), id: () => `x${n++}` };
    const expected = (retry: 0 | 4) => buildModel([lesson], [...quizEvents(lesson, quiz, quiz.questions.map(() => false), stamp),
      ...quizEvents(lesson, quiz, quiz.questions.map(() => true), stamp, retry)]).concepts.get("names")!.masteryEstimate;
    expect(expected(4)).not.toBe(expected(0)); // the two cases are distinguishable
    const row = await screen.findByRole("row", { name: /^names/ });
    expect(row.querySelectorAll("td")[2]!.textContent).toMatch(new RegExp(`^${Math.round(expected(4) * 100)}% `));
    expect(appended).toEqual([]); // nothing went to (missing) storage
  });

  it("reads lessons from the same snapshot as everything else", async () => {
    staleLessons = [{ lessonId: "py-values-names", steps: {}, furthestStep: 0, completed: false, mastery: 0, struggles: {} } as unknown as LessonProgress];
    lessonsAfter = [completedRecord()];
    const { App } = await import("./App");
    location.hash = "#/lesson/py-values-names/0";
    render(<App />);
    await waitFor(() => expect(positions).toBe(1));
    expect(screen.getByLabelText(/lessons completed/).getAttribute("aria-label")).toMatch(/^1 of /);
    expect(savedRecords.every((p) => p.completed)).toBe(true);
  });

  it("models exercise practice too when storage can't be opened", async () => {
    openFails = true;
    const lesson = (await import("../content/lessons/py-values-names.json")).default as unknown as Lesson;
    const at = lesson.steps.findIndex((st) => st.id === "circle");
    runTests = (lesson.steps[at] as unknown as { tests: { name: string; concept?: string }[] }).tests;
    const { App } = await import("./App");
    location.hash = `#/lesson/py-values-names/${at}`;
    render(<App />);
    await screen.findByText(/Progress can't be saved in this browser/);
    fireEvent.click(await screen.findByRole("button", { name: /Run checks/ }));
    await screen.findByText(/All checks pass/);
    await new Promise((r) => setTimeout(r, 20));
    await act(async () => { location.hash = "#/review"; dispatchEvent(new HashChangeEvent("hashchange")); });
    const concepts = new Set(runTests.map((t) => t.concept).filter(Boolean));
    expect(concepts.size).toBeGreaterThan(0);
    for (const c of concepts) expect(await screen.findByRole("row", { name: new RegExp(`^${c} `) })).toBeTruthy();
    runTests = [];
  });
});
