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
let finishImport: () => void = () => {};
const fake: ProgressStore & { close(): void } = {
  close: () => {},
  getLesson: async () => undefined,
  allLessons: async () => [],
  putLesson: async (p) => { saved.push(p.lessonId); },
  getDraft: async () => undefined,
  putDraft: async () => {},
  getPosition: async () => null,
  setPosition: async () => {},
  appendEvents: async (evs) => { appended.push(...evs); },
  allEvents: async () => [],
  getAssistance: async () => 0,
  raiseAssistance: () => { raised += 1; return new Promise<number>((resolve) => { release = resolve; }); },
  exportAll: async (): Promise<ProgressExport> => ({ format: "python-intelligence-progress", version: 2, exportedAt: new Date().toISOString(),
    lessons: [], drafts: {}, position: null, events: [], assistance: {} }),
  importAll: () => new Promise<void>((resolve) => { finishImport = resolve; }),
  clear: async () => {},
};
vi.mock("./progress/store", () => ({ openProgressStore: async () => fake }));
vi.mock("./py/runner", () => ({ getRunner: () => ({ warm: async () => {}, run: async () => { throw new Error("not used"); } }) }));
vi.mock("./sw-register", () => ({ waitForController: () => new Promise(() => {}) }));

afterEach(() => { cleanup(); appended.length = 0; saved.length = 0; raised = 0; });

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
    fireEvent.click(screen.getByRole("button", { name: "Progress" }));
    const file = new File([JSON.stringify({ format: "python-intelligence-progress", version: 2 })], "p.json", { type: "application/json" });
    fireEvent.change(document.querySelector("input[type=file]")!, { target: { files: [file] } });
    await waitFor(() => expect(document.querySelector("main")!.hasAttribute("inert")).toBe(true));
    const before = saved.length;
    fireEvent.click(screen.getByRole("button", { name: "Check answers" })); // inert doesn't stop a synthetic click
    await new Promise((r) => setTimeout(r, 20));
    expect(saved.length).toBe(before);
    expect(raised).toBe(0);
    expect(appended).toEqual([]);
    await act(async () => { finishImport(); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector("main")!.hasAttribute("inert")).toBe(false));
    expect(appended).toEqual([]);
  });
});
