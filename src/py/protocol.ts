import type { PyTest } from "../content/types";

export const PYODIDE_VERSION = "0.27.8"; // Python 3.12.7; pinned, verified 2026-11-08
export const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * Program output kept per run, in characters (stdout and stderr together, a newline counting as one). The worker drops
 * the rest before it reaches the page, so a print loop can't flood the main thread or the console's live region; the
 * run's time limit still stops a loop that keeps going.
 */
export const MAX_OUTPUT_CHARS = 100_000;
export const OUTPUT_TRUNCATED = `[output truncated: only the first ${MAX_OUTPUT_CHARS.toLocaleString("en")} characters are shown]`;

export interface PyError {
  type: string;
  message: string;
  line: number | null;
  summary: string;
  /** For a NameError: every name the learner's code binds, from Python's own parser (harness.bound_names). */
  bound?: string[];
}

export interface TestResult {
  name: string;
  passed: boolean;
  errorType: string | null;
  message: string;
  concept?: string | null;
  /** For a NameError raised while the check ran the learner's code: every name the code binds (harness.bound_names). */
  bound?: string[];
}

export interface RunResult {
  ok: boolean;
  error: PyError | null;
  tests: TestResult[];
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type ToWorker = { id: number; type: "run"; code: string; tests: PyTest[]; packages?: string[] };

export type FromWorker =
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { id: number; type: "packages-loading" | "packages-ready"; message?: string }
  | { id: number; type: "stdout" | "stderr"; text: string }
  | { id: number; type: "result"; result: Omit<RunResult, "stdout" | "stderr" | "durationMs"> };

/**
 * Failures of the system rather than of the learner's code: Python or a package didn't load, or the worker crashed.
 * They record no attempt and get no tutor feedback. A TimeoutError is different: the learner's code ran too long.
 */
export const INFRASTRUCTURE_ERRORS: ReadonlySet<string> = new Set(["LoadError", "PackageError", "WorkerError"]);
