import { describe, expect, it } from "vitest";
import { feedbackForError, feedbackForTests } from "./feedback";

// Master prompt test matrix T01-T03: feedback is tied to the verified failure and never claims anything ran or passed.
describe("tutor feedback for verified failures", () => {
  it("T01: a SyntaxError names its line and says nothing ran", () => {
    const fb = feedbackForError({ type: "SyntaxError", message: "expected ':'", line: 4, summary: "SyntaxError: expected ':'" });
    expect(fb.diagnosis).toContain("line 4");
    expect(fb.diagnosis).toContain("nothing ran");
  });

  it("T02: an IndexError is explained at its line, with a concrete next step", () => {
    const fb = feedbackForError({ type: "IndexError", message: "list index out of range", line: 7, summary: "" });
    expect(fb.diagnosis).toContain("Line 7");
    expect(fb.diagnosis).toContain("list index out of range");
    expect(fb.question).toContain("its last index is len(x) - 1");
    expect(fb.question).toContain("an empty one has no valid index"); // len(x) - 1 is -1 for an empty list, still out of range
    expect(fb.action).toMatch(/Print len\(x\)/);
  });

  it("KeyError and AttributeError get their own line-specific advice", () => {
    expect(feedbackForError({ type: "KeyError", message: "'b'", line: 2, summary: "" }).diagnosis).toContain("Line 2");
    expect(feedbackForError({ type: "AttributeError", message: "'NoneType' object has no attribute 'append'", line: 5, summary: "" }).action)
      .toContain("None");
  });

  it("T03: a wrong result with valid syntax is diagnosed from the failed checks", () => {
    const fb = feedbackForTests([
      { name: "adds two numbers", passed: true, errorType: null, message: "" },
      { name: "handles zero", passed: false, errorType: "AssertionError", message: "expected 0, got None" },
    ]);
    expect(fb?.diagnosis).toContain("1 of 2 checks failed");
    expect(fb?.diagnosis).toContain("handles zero");
    expect(fb?.diagnosis).toContain("expected 0, got None");
  });

  it("no feedback is invented when every check passed", () => {
    expect(feedbackForTests([{ name: "a", passed: true, errorType: null, message: "" }])).toBeNull();
  });

  it("an error raised inside a check is explained as that error, naming the check", () => {
    const fb = feedbackForTests([{ name: "empty list", passed: false, errorType: "IndexError", message: "list index out of range" }]);
    expect(fb?.diagnosis).toMatch(/^While checking "empty list": /);
    expect(fb?.diagnosis).toContain("list index out of range");
    expect(fb?.diagnosis).toContain("Your code asked for");
    expect(fb?.diagnosis).not.toContain("Line ?");
  });
});
