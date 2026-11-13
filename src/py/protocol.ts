import type { PyTest } from "../content/types";

export const PYODIDE_VERSION = "0.27.8"; // Python 3.12.7; pinned, verified 2026-11-08
export const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export interface PyError {
  type: string;
  message: string;
  line: number | null;
  summary: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  errorType: string | null;
  message: string;
  concept?: string | null;
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
