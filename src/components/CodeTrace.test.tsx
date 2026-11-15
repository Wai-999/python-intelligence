import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../py/protocol";
import { CodeTrace } from "./CodeTrace";

const run = vi.fn<(...args: unknown[]) => Promise<RunResult>>();
vi.mock("../py/runner", () => ({ getRunner: () => ({ run }) }));
const frame = (line: number, note: string) => ({ line, locals: {}, stack: ["<module>"], note });
const traced = { ok: true, error: null, tests: [], stdout: "", stderr: "", durationMs: 1,
  trace: { frames: [frame(1, "Next: line 1."), frame(2, "Next: line 2."), frame(2, "The program has finished.")], truncated: false, limit: 300, outputCut: false } } as RunResult;
afterEach(() => { cleanup(); run.mockReset(); });

describe("CodeTrace", () => {
  it("says so when Python can't start, and the button tries again", async () => {
    run.mockRejectedValueOnce(new Error("Python failed to load: offline.")).mockResolvedValueOnce(traced);
    render(<CodeTrace code={"x = 1\ny = 2\n"} />);
    fireEvent.click(screen.getByRole("button", { name: "Show execution trace" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Couldn't trace this: Python failed to load/));
    fireEvent.click(screen.getByRole("button", { name: "Show execution trace" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Execution visualiser" })).toBeTruthy());
    expect(screen.queryByText(/Couldn't trace this/)).toBeNull();
  });

  it("starts Trace again from step 1, even for the same code", async () => {
    run.mockResolvedValue(traced);
    render(<CodeTrace code={"x = 1\ny = 2\n"} />);
    fireEvent.click(screen.getByRole("button", { name: "Show execution trace" }));
    await waitFor(() => screen.getByRole("button", { name: "Step ▶" }));
    fireEvent.click(screen.getByRole("button", { name: "Step ▶" }));
    expect(screen.getByText(/Step 2 of 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Trace again" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/Step 1 of 3/)).toBeTruthy());
  });
});
