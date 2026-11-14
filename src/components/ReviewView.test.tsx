import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Lesson } from "../content/types";
import { buildModel, POLICY_VERSION, type LearnerEvent, type Task } from "../learner/model";
import { ReviewView } from "./ReviewView";

const lesson = { id: "basics", title: "Basics", summary: "", track: "python", level: 1, estimated_minutes: 10, prerequisites: [],
  concepts: ["loops"], sources: [], license: "", steps: [] } as unknown as Lesson;
const T0 = Date.parse("2026-01-05T09:00:00.000Z");
const at = (days: number, hours = 0) => new Date(T0 + days * 86400000 + hours * 3600000).toISOString();
let n = 0;
const ev = (when: string, task: Task, stepId: string): LearnerEvent =>
  ({ id: `e${++n}`, at: when, lessonId: "basics", stepId, task, concept: "loops", passed: true, assistance: 0, policy: POLICY_VERSION });

afterEach(cleanup);

describe("ReviewView's words for the model's states", () => {
  it("calls the earliest mastered state what the evidence shows: remembered in spaced reviews (days 1 and 3), not weeks", () => {
    // Two independent exercises and a quiz complete the concept; two on-time spaced reviews make it mastered.
    const events = [ev(at(0), "exercise", "a"), ev(at(0, 1), "exercise", "b"), ev(at(0, 2), "quiz", "q"),
      ev(at(1, 3), "review", "r1"), ev(at(4, 5), "review", "r2")];
    const model = buildModel([lesson], events);
    expect(model.concepts.get("loops")!.status).toBe("mastered");
    render(<ReviewView lessons={[lesson]} model={model} events={events} now={at(5)} titleOf={() => "Basics"} onAnswer={() => {}} />);
    const row = screen.getByRole("row", { name: /^loops/ });
    expect(within(row).getByText("remembered in spaced reviews")).toBeTruthy();
    expect(row.textContent).not.toMatch(/weeks/);
  });

  it("offers Continue to the saved position only when nothing is due", () => {
    const model = buildModel([lesson], []);
    render(<ReviewView lessons={[lesson]} model={model} events={[]} now={at(0)} titleOf={() => "Basics"} onAnswer={() => {}}
                       continueTo={{ href: "#/lesson/basics/2", title: "Basics" }} />);
    expect(screen.getByRole("link", { name: "Continue: Basics →" }).getAttribute("href")).toBe("#/lesson/basics/2");
  });
});
