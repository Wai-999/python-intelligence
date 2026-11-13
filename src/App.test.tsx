import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearnerEvent } from "./learner/model";
import type { ProgressExport, ProgressStore } from "./progress/types";

// A deterministic race: the quiz's raiseAssistance stays pending while progress is reset, then resolves.
// Nothing from before the reset may reach memory or storage.

let release: (before: number) => void = () => {};
const appended: LearnerEvent[] = [];
const fake: ProgressStore & { close(): void } = {
  close: () => {},
  getLesson: async () => undefined,
  allLessons: async () => [],
  putLesson: async () => {},
  getDraft: async () => undefined,
  putDraft: async () => {},
  getPosition: async () => null,
  setPosition: async () => {},
  appendEvents: async (evs) => { appended.push(...evs); },
  allEvents: async () => [],
  getAssistance: async () => 0,
  raiseAssistance: () => new Promise<number>((resolve) => { release = resolve; }),
  exportAll: async (): Promise<ProgressExport> => ({ format: "python-intelligence-progress", version: 2, exportedAt: new Date().toISOString(),
    lessons: [], drafts: {}, position: null, events: [], assistance: {} }),
  importAll: async () => {},
  clear: async () => {},
};
vi.mock("./progress/store", () => ({ openProgressStore: async () => fake }));
vi.mock("./py/runner", () => ({ getRunner: () => ({ warm: async () => {}, run: async () => { throw new Error("not used"); } }) }));
vi.mock("./sw-register", () => ({ waitForController: () => new Promise(() => {}) }));

afterEach(cleanup);

describe("App", () => {
  it("drops a quiz result whose storage write finishes after a reset", async () => {
    const { App } = await import("./App");
    const lesson = (await import("../content/lessons/py-values-names.json")).default as unknown as { steps: { kind: string; questions?: { answer: number }[] }[] };
    const at = lesson.steps.findIndex((s) => s.kind === "quiz");
    location.hash = `#/lesson/py-values-names/${at}`;
    render(<App />);
    await screen.findByRole("button", { name: "Check answers" });
    const sets = document.querySelectorAll("fieldset.question");
    lesson.steps[at]!.questions!.forEach((q, i) => fireEvent.click(sets[i]!.querySelectorAll("input[type=radio]")[q.answer]!));
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
});
