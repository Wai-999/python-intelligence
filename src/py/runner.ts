import type { PyTest } from "../content/types";
import type { FromWorker, RunResult } from "./protocol";

export type RunnerStatus = "idle" | "loading" | "ready" | "loading-packages" | "running" | "error";

/**
 * Main-thread facade over the Pyodide worker.
 * GitHub Pages cannot send COOP/COEP headers, so SharedArrayBuffer-based interrupts are unavailable.
 * Time limits are therefore enforced by terminating the worker and starting a fresh one.
 */
export class PythonRunner {
  private worker: Worker | null = null;
  private loaded: Promise<void> | null = null;
  private nextId = 1;
  private listeners = new Set<(s: RunnerStatus) => void>();
  status: RunnerStatus = "idle";
  lastLoadError: string | null = null;

  constructor(private readonly makeWorker: () => Worker = defaultWorker) {}

  onStatus(fn: (s: RunnerStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: RunnerStatus) {
    this.status = s;
    this.listeners.forEach((fn) => fn(s));
  }

  /** Start loading Pyodide (idempotent). */
  warm(loadTimeoutMs = 90_000): Promise<void> {
    if (this.loaded) return this.loaded;
    this.set("loading");
    const w = this.makeWorker();
    this.worker = w;
    this.loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail("Python took too long to load. Check your connection and retry."), loadTimeoutMs);
      const fail = (message: string) => {
        clearTimeout(timer);
        this.lastLoadError = message;
        this.reset("error");
        reject(new Error(message));
      };
      const onMsg = (ev: MessageEvent<FromWorker>) => {
        if (ev.data.type === "ready") {
          clearTimeout(timer);
          w.removeEventListener("message", onMsg);
          this.set("ready");
          resolve();
        } else if (ev.data.type === "load-error") {
          w.removeEventListener("message", onMsg);
          fail(`Python failed to load: ${ev.data.message}`);
        }
      };
      w.addEventListener("message", onMsg);
      w.addEventListener("error", (e) => fail(`Python worker error: ${e.message}`), { once: true });
    });
    return this.loaded;
  }

  private reset(status: RunnerStatus) {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = null;
    this.set(status);
  }

  private queue: Promise<unknown> = Promise.resolve();

  run(code: string, tests: PyTest[] = [], opts: { packages?: string[]; packageTimeoutMs?: number; timeoutMs?: number; onOutput?: (stream: "stdout" | "stderr", text: string) => void } = {}): Promise<RunResult> {
    const run = this.queue.then(() => this.execute(code, tests, opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async execute(code: string, tests: PyTest[] = [], opts: { packages?: string[]; packageTimeoutMs?: number; timeoutMs?: number; onOutput?: (stream: "stdout" | "stderr", text: string) => void } = {}): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    await this.warm();
    const w = this.worker!;
    const id = this.nextId++;
    const started = performance.now();
    let stdout = "";
    let stderr = "";
    this.set(opts.packages?.length ? "loading-packages" : "running");
    return new Promise<RunResult>((resolve) => {
      const done = (r: RunResult, status: RunnerStatus = "ready") => {
        clearTimeout(timer);
        w.removeEventListener("message", onMsg);
        if (status === "ready") this.set("ready");
        resolve(r);
      };
      const timedOut = () => {
        // Infinite loop or very slow code: kill the interpreter. Next run gets a fresh one.
        this.reset("idle");
        done({
          ok: false, tests: [], stdout, stderr, durationMs: performance.now() - started,
          error: { type: "TimeoutError", line: null, summary: `TimeoutError: stopped after ${timeoutMs / 1000}s`,
                   message: `Your code ran for more than ${timeoutMs / 1000} seconds and was stopped. Look for a loop whose condition never becomes false.` },
        }, "idle");
      };
      let timer = setTimeout(() => {
        this.reset("idle");
        const message = "Lesson packages took too long to load. Check your connection and run again.";
        done({ ok: false, tests: [], stdout, stderr, durationMs: performance.now() - started,
          error: { type: "LoadError", line: null, summary: message, message } }, "idle");
      }, opts.packageTimeoutMs ?? 90_000);
      const onMsg = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (!("id" in m) || m.id !== id) return;
        if (m.type === "packages-loading") {
          this.set("loading-packages");
        } else if (m.type === "packages-ready") {
          clearTimeout(timer);
          timer = setTimeout(timedOut, timeoutMs);
          this.set("running");
        } else if (m.type === "stdout" || m.type === "stderr") {
          const text = m.text + "\n";
          if (m.type === "stdout") stdout += text; else stderr += text;
          opts.onOutput?.(m.type, text);
        } else if (m.type === "result") {
          done({ ...m.result, stdout, stderr, durationMs: performance.now() - started });
        }
      };
      w.addEventListener("message", onMsg);
      w.postMessage({ id, type: "run", code, tests, packages: opts.packages ?? [] });
    });
  }
}

function defaultWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "python" });
}

let shared: PythonRunner | null = null;
export const getRunner = () => (shared ??= new PythonRunner());
