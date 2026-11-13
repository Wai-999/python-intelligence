import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExerciseStep } from "../content/types";
import type { RunResult } from "../py/protocol";
import { Exercise } from "./Exercise";

const run = vi.fn<(...args: unknown[]) => Promise<RunResult>>();
vi.mock("../py/runner", () => ({ getRunner: () => ({ run }) }));
vi.mock("./usePython", () => ({ usePythonStatus: () => "ready", STATUS_TEXT: { ready: "Python ready" } }));

const step = { id: "e1", kind: "guided", title: "t", body: "", starter: "x = 1\n", hints: ["one"], solution: "x = 2\n",
  tests: [{ name: "x is 2", code: "assert x == 2", concept: "names" }] } as unknown as ExerciseStep;
const failed = (type: string): RunResult => ({ ok: false, tests: [], stdout: "", stderr: "", durationMs: 1,
  error: { type, message: type, line: null, summary: type } });

function mount(tier = 2, ex: ExerciseStep = step) {
  const onResult = vi.fn();
  render(<Exercise step={ex} lessonId="l" draft={undefined} record={undefined} assistance={0} onAssist={() => {}}
                   generation={3} suggestedTier={tier} onDraft={() => {}} onResult={onResult} />);
  return onResult;
}
const runChecks = () => fireEvent.click(screen.getByRole("button", { name: /Run checks/ }));

describe("Exercise attempts", () => {
  beforeEach(() => run.mockReset());
  afterEach(cleanup);

  it("records no attempt when Python itself failed to load or a package failed", async () => {
    for (const type of ["LoadError", "PackageError", "WorkerError"]) {
      run.mockResolvedValueOnce(failed(type));
      const onResult = mount();
      runChecks();
      await waitFor(() => expect(run).toHaveBeenCalled());
      await waitFor(() => expect((screen.getByRole("button", { name: /Run checks/ }) as HTMLButtonElement).disabled).toBe(false));
      expect(onResult).not.toHaveBeenCalled();
      cleanup();
      run.mockReset();
    }
  });

  it("records one attempt for an ordinary failure, tagged with its generation and the help seen", async () => {
    run.mockResolvedValueOnce({ ok: true, tests: [{ name: "x is 2", passed: false, message: "no", concept: "names" }], stdout: "", stderr: "", durationMs: 1 } as RunResult);
    const onResult = mount();
    fireEvent.click(screen.getByRole("button", { name: /Show a hint/ }));
    runChecks();
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0]![2]).toEqual({ results: [{ concept: "names", passed: false }], assistance: 1, generation: 3 });
  });

  it("records a timeout as a failed attempt: the learner's code ran too long", async () => {
    run.mockResolvedValueOnce(failed("TimeoutError"));
    const onResult = mount();
    runChecks();
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0]![0]).toBe(false);
    expect(onResult.mock.calls[0]![2]).toMatchObject({ results: null });
  });

  it("records a code error as a failed attempt for every concept (results null)", async () => {
    run.mockResolvedValueOnce(failed("NameError"));
    const onResult = mount();
    runChecks();
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0]![2]).toMatchObject({ results: null, assistance: 0 });
  });
});

describe("scaffold fading", () => {
  beforeEach(() => run.mockReset());
  afterEach(cleanup);
  const three = { ...step, hints: ["one.", "two.", "three."] } as unknown as ExerciseStep;
  const note = () => screen.getByRole("note").textContent!;
  const hintButton = () => screen.getByRole("button", { name: /Show a hint|Another hint/ }).textContent!;
  const fail = async (onResult: ReturnType<typeof vi.fn>, n: number) => {
    run.mockResolvedValueOnce({ ok: true, tests: [{ name: "x is 2", passed: false, message: "no", concept: "names" }], stdout: "", stderr: "", durationMs: 1 } as RunResult);
    runChecks();
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(n));
  };

  it("asks for a prediction first at tier 0, while hints stay available on request", () => {
    mount(0, three);
    expect(note()).toMatch(/^Predict first/);
    expect(hintButton()).toBe("Show a hint (3 left)");
  });

  it("suggests the model's number of hints, and says when support has eased off", () => {
    mount(2, three);
    expect(note()).toBe("Suggested support: up to 2 hints. Use more or fewer as you like.");
    expect(hintButton()).toBe("Show a hint (suggested, 3 left)");
    fireEvent.click(screen.getByRole("button", { name: /Show a hint/ }));
    fireEvent.click(screen.getByRole("button", { name: /Another hint/ }));
    expect(hintButton()).toBe("Another hint (1 left)"); // beyond the suggestion: still there, just not suggested
    cleanup();
    mount(1, three);
    expect(note()).toMatch(/up to 1 hint, fewer than at first since you've solved similar tasks on your own/);
  });

  it("restores one tier of support per two failed runs, up to tier 3", async () => {
    const five = { ...step, hints: ["one.", "two.", "three.", "four.", "five."] } as unknown as ExerciseStep;
    const onResult = mount(0, five);
    await fail(onResult, 1);
    expect(note()).toMatch(/^Predict first/);
    await fail(onResult, 2);
    expect(note()).toMatch(/up to 1 hint, raised after repeated tries/);
    for (let n = 3; n <= 8; n++) await fail(onResult, n);
    expect(note()).toMatch(/up to 3 hints, raised/);
  });

  it("never suggests more hints than the exercise has", () => {
    mount(3);
    expect(note()).toMatch(/up to 1 hint\b/);
  });
});
