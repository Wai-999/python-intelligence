import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intervention } from "../learner/loop";
import { MesoPanel } from "./MesoPanel";

afterEach(cleanup);
const titleOf = (id: string) => `Lesson ${id}`;
const typeError: Intervention = { kind: "counterexample", concept: "names", signature: "error:TypeError", supports: ["a", "b", "c"] };

describe("MesoPanel", () => {
  it("asks for a prediction, explains it, then offers the transfer task", () => {
    const onOutcome = vi.fn();
    render(<MesoPanel intervention={typeError} target={{ lessonId: "py-x", stepIndex: 4, title: "Totals" }} titleOf={titleOf} onOutcome={onOutcome} />);
    expect(screen.getByRole("heading", { name: "Let's step back for a moment" })).toBe(document.activeElement);
    fireEvent.click(screen.getByRole("radio", { name: "It prints 34" }));
    fireEvent.click(screen.getByRole("button", { name: "Check my prediction" }));
    expect(onOutcome).toHaveBeenCalledWith("answered");
    expect(screen.getByRole("status").textContent).toMatch(/^Not quite: It stops with a TypeError\./);
    const link = screen.getByRole("link", { name: "Totals" });
    expect(link.getAttribute("href")).toBe("#/lesson/py-x/4");
    expect(screen.getByRole("status").textContent).toContain("(Lesson py-x)");
  });

  it("says plainly when no independent transfer task is available, without promising anything", () => {
    render(<MesoPanel intervention={{ ...typeError, signature: "check:names" }} target={null} titleOf={titleOf} onOutcome={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "I've compared them" }));
    const text = screen.getByRole("status").textContent!;
    expect(text).toBe("There isn't another exercise on names here that could count as an independent check right now.");
    expect(text).not.toMatch(/review|help/i);
  });

  it("lets the learner postpone, and asks for independence after strong help", () => {
    const onOutcome = vi.fn();
    render(<MesoPanel intervention={{ kind: "independence", concept: "loops", signature: "help:strong", supports: [] }} target={null} titleOf={titleOf} onOutcome={onOutcome} />);
    expect(screen.getByText(/leaned on strong hints or the solution/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onOutcome).toHaveBeenCalledWith("postponed");
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });
});
