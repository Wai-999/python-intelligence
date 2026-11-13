import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearnerEvent } from "./learner/model";
import type { ProgressExport, ProgressStore } from "./progress/types";

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
const fake: ProgressStore & { close(): void } = {
  close: () => {},
  getLesson: async () => undefined,
  allLessons: async () => [],
  putLesson: async (p) => { saved.push(p.lessonId); },
  getDraft: async () => undefined,
  putDraft: async () => {},
  getPosition: async () => null,
  setPosition: async () => { positions += 1; },
  appendEvents: async (evs) => { appended.push(...evs); },
  allEvents: async () => [],
  getAssistance: async () => 0,
  raiseAssistance: () => { raised += 1; return new Promise<number>((resolve) => { release = resolve; }); },
  exportAll: async (): Promise<ProgressExport> => ({ format: "python-intelligence-progress", version: 2, exportedAt: new Date().toISOString(),
    lessons: [], drafts: {}, position: null, events: history, assistance: {} }),
  importAll: () => new Promise<void>((resolve) => { pendingImports.push(resolve); }),
  clear: async () => {},
};
vi.mock("./progress/store", () => ({ openProgressStore: async () => fake }));
vi.mock("./py/runner", () => ({ getRunner: () => ({ warm: async () => {}, run: async () => { throw new Error("not used"); } }) }));
vi.mock("./sw-register", () => ({ waitForController: () => new Promise(() => {}) }));

afterEach(() => { cleanup(); appended.length = 0; saved.length = 0; raised = 0; positions = 0; history = []; pendingImports.length = 0; });

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
});
