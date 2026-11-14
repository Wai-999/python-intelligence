/**
 * Offline "professor" feedback. Deterministic templates, NOT a generative model: the UI labels it so.
 * Turns a Python error or failed test into a short diagnosis, a Socratic question, and a next action.
 */
import type { PyError, TestResult } from "../py/protocol";

export interface Feedback {
  diagnosis: string;
  question: string;
  action: string;
}

/** Where the error happened: its line when known (an error raised inside a check has none). */
const where = (e: PyError) => (e.line ? `Line ${e.line}` : "Your code");

const BY_ERROR: Record<string, (e: PyError) => Feedback> = {
  SyntaxError: (e) => ({
    diagnosis: `Python couldn't read line ${e.line ?? "?"} as valid code, so nothing ran.`,
    question: "Does every opening bracket or quote have a matching close, and does each `def`, `if` or `for` line end with a colon?",
    action: "Read the marked line and the one just above it. Syntax errors are often reported one line late.",
  }),
  IndentationError: (e) => ({
    diagnosis: `The indentation around line ${e.line ?? "?"} doesn't match the block structure Python expects.`,
    question: "Which lines belong inside the function body? Are they all indented by the same amount?",
    action: "Indent every line of a block by exactly 4 spaces, and don't mix tabs with spaces.",
  }),
  NameError: (e) => ({
    diagnosis: `A name was used before Python knew about it: ${e.message}.`,
    question: "Where is this name defined? Is it spelled the same way (including capitals) in both places, and is it defined before it is used?",
    action: "Check the spelling, or move the definition above the line that uses it.",
  }),
  TypeError: (e) => ({
    diagnosis: `A value was used in a way its type doesn't support: ${e.message}.`,
    question: "What type is each value on that line? Try printing `type(x)` for the suspicious one.",
    action: "Check the number of arguments in the call against the `def` line, and convert types where needed (e.g. `int(...)`, `str(...)`).",
  }),
  ValueError: (e) => ({
    diagnosis: `A value of the right type had an unacceptable content: ${e.message}.`,
    question: "What exact value reached that line? Can you print it just before?",
    action: "Validate or convert the input before using it.",
  }),
  IndexError: (e) => ({
    diagnosis: `${where(e)} asked for a position that the list (or string) doesn't have: ${e.message}.`,
    question: "How long is the sequence at that moment, and which index was used? The last valid index is len(x) - 1.",
    action: "Print len(x) and the index just before that line, or loop over the items instead of counting positions.",
  }),
  KeyError: (e) => ({
    diagnosis: `${where(e)} looked up a key the dictionary doesn't contain: ${e.message}.`,
    question: "Which keys does the dictionary have at that moment? Could the key differ in spelling, case or type (\"1\" vs 1)?",
    action: "Print the dictionary's keys just before that line, or use d.get(key, default) when a missing key is expected.",
  }),
  AttributeError: (e) => ({
    diagnosis: `${where(e)} used a method or attribute that this kind of value doesn't have: ${e.message}.`,
    question: "What type is the value on the left of the dot? Is it what you expected (for example a list, not None)?",
    action: "Print type(x) just before that line. A function that forgets to return gives None.",
  }),
  ZeroDivisionError: () => ({
    diagnosis: "The code divided by zero.",
    question: "Which input makes the divisor zero, and what should the function do then?",
    action: "Handle that case explicitly before dividing.",
  }),
  RecursionError: () => ({
    diagnosis: "A function kept calling itself without reaching a stopping case.",
    question: "What is the base case, and does every recursive call move closer to it?",
    action: "Add or fix the base case.",
  }),
  TimeoutError: () => ({
    diagnosis: "The code ran too long and was stopped. This is usually an infinite loop.",
    question: "In each loop, which variable changes on every pass, and will the loop condition eventually become false?",
    action: "Make sure the loop variable is updated inside the loop body.",
  }),
};

export function feedbackForError(e: PyError): Feedback {
  return (BY_ERROR[e.type] ?? ((x: PyError) => ({
    diagnosis: `Python raised ${x.type}: ${x.message}`,
    question: "Which line raised it, and what were the values of the variables there?",
    action: "Add a print() just before that line to inspect the values.",
  })))(e);
}

export function feedbackForTests(results: TestResult[]): Feedback | null {
  const failed = results.filter((t) => !t.passed);
  if (failed.length === 0) return null;
  const first = failed[0]!;
  if (first.errorType && first.errorType !== "AssertionError") {
    const fb = feedbackForError({ type: first.errorType, message: first.message, line: null, summary: first.message });
    return { ...fb, diagnosis: `While checking "${first.name}": ${fb.diagnosis}` };
  }
  if (first.message.includes("not defined") || first.errorType === "NameError") {
    return feedbackForError({ type: "NameError", message: first.message, line: null, summary: first.message });
  }
  return {
    diagnosis: `${failed.length} of ${results.length} checks failed. First: "${first.name}". ${first.message}`,
    question: "What did the check expect, and what does your function actually return for that input? Try calling it with that input and printing the result.",
    action: failed.length === results.length
      ? "Start with the simplest case in the task description and get it working first."
      : "Most checks pass, so look at what is special about the failing case (an edge case like zero, empty or negative).",
  };
}
