/// <reference lib="webworker" />
// Runs Pyodide off the main thread. NOTE: this is isolation for responsiveness, not a security
// boundary: learner code runs with the page's origin inside the worker (no DOM, no host access).
import manifest from "./packages.json";
import { packageRules } from "./packages";
import harness from "./harness.py?raw";
import { MAX_OUTPUT_CHARS, OUTPUT_TRUNCATED, PYODIDE_INDEX, type FromWorker, type ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

interface Pyodide {
  loadedPackages: Record<string, string>;
  loadPackage(names: string[], options: {
    messageCallback: (message: string) => void;
    errorCallback: (message: string) => void;
  }): Promise<unknown>;
  runPython(code: string): unknown;
  globals: { get(name: string): (...args: unknown[]) => string };
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
  setStdin(o: { error: boolean }): void;
}

const post = (m: FromWorker) => self.postMessage(m);
const rules = packageRules(manifest);
let currentId = 0;              // the run whose stdout/stderr Pyodide is producing
let outputUsed = 0;             // characters of output this run has sent (see MAX_OUTPUT_CHARS)
let outputCut = false;          // the cap was reached: the rest of this run's output is dropped

/** Sends one line of output, within the run's output budget; the first line past it is cut and followed by a note. */
function emit(type: "stdout" | "stderr", text: string) {
  if (outputCut) return;
  const size = text.length + 1; // the newline the runner adds back
  if (outputUsed + size <= MAX_OUTPUT_CHARS) {
    outputUsed += size;
    post({ id: currentId, type, text });
    return;
  }
  const room = MAX_OUTPUT_CHARS - outputUsed - 1;
  if (room > 0) post({ id: currentId, type, text: text.slice(0, room) });
  outputUsed = MAX_OUTPUT_CHARS;
  outputCut = true;
  post({ id: currentId, type: "stderr", text: OUTPUT_TRUNCATED });
}
const imported = new Set<string>(); // modules already imported once (first-import cost paid)

const ready: Promise<Pyodide> = (async () => {
  const mod = await import(/* @vite-ignore */ `${PYODIDE_INDEX}pyodide.mjs`);
  const py: Pyodide = await mod.loadPyodide({ indexURL: PYODIDE_INDEX });
  py.setStdout({ batched: (text) => emit("stdout", text) });
  py.setStderr({ batched: (text) => emit("stderr", text) });
  py.setStdin({ error: true }); // input() raises instead of hanging: lessons don't use stdin
  py.runPython(harness);
  return py;
})();

ready.then(
  () => post({ type: "ready" }),
  (e) => post({ type: "load-error", message: String(e?.message ?? e) }),
);

// One run at a time: a message that arrives while another run awaits package loading waits its turn, so
// output is always attributed to the run that produced it and the same package is never loaded twice at once.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type !== "run") return;
  queue = queue.then(() => handle(msg)).catch((e) => {
    const message = `Python worker error: ${String(e?.message ?? e)}`;
    post({ id: msg.id, type: "result", result: { ok: false, tests: [], error: { type: "WorkerError", message, summary: message, line: null } } });
  });
};

async function handle(msg: ToWorker) {
  const py = await ready;
  currentId = msg.id;
  outputUsed = 0; // each run gets its own output budget
  outputCut = false;
  const requested = [...new Set(msg.packages ?? [])];
  const unsupported = rules.unsupported(requested);
  if (unsupported.length) {
    const message = `Unsupported lesson packages: ${unsupported.join(", ")}`;
    post({ id: msg.id, type: "result", result: { ok: false, tests: [], error: {
      type: "PackageError", message, summary: message, line: null,
    } } });
    return;
  }
  try {
    // Dependencies count as loaded (pandas brings numpy), so they are not downloaded again.
    const { toLoad, toImport } = rules.plan(requested, py.loadedPackages, imported);
    if (toLoad.length || toImport.length) post({ id: msg.id, type: "packages-loading" });
    if (toLoad.length) {
      const errors: string[] = [];
      await py.loadPackage(toLoad, {
        messageCallback: (message) => post({ id: msg.id, type: "packages-loading", message }),
        errorCallback: (message) => { errors.push(message); },
      });
      const notLoaded = requested.filter((name) => !Object.hasOwn(py.loadedPackages, name));
      if (notLoaded.length || errors.length) {
        throw new Error(`Missing packages: ${notLoaded.join(", ") || "none"}. ${errors.join("; ")}`);
      }
    }
    // Import initialization belongs to loading, outside the learner code timeout.
    for (const mod of toImport) {
      py.runPython(`import ${mod}`);
      imported.add(mod);
    }
  } catch (e) {
    const message = `Lesson packages failed to load. Check your connection and run again. ${String(e)}`;
    post({ id: msg.id, type: "result", result: { ok: false, tests: [], error: {
      type: "LoadError", message, summary: message, line: null,
    } } });
    return;
  }
  post({ id: msg.id, type: "packages-ready" });
  const runJson = py.globals.get("run_json");
  currentId = msg.id;
  const result = JSON.parse(runJson(msg.code, JSON.stringify(msg.tests)));
  post({ id: msg.id, type: "result", result });
}
