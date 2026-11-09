/// <reference lib="webworker" />
// Runs Pyodide off the main thread. NOTE: this is isolation for responsiveness, not a security
// boundary: learner code runs with the page's origin inside the worker (no DOM, no host access).
import packages from "./packages.json";
import harness from "./harness.py?raw";
import { PYODIDE_INDEX, type FromWorker, type ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

interface Pyodide {
  loadPackage(names: string[]): Promise<unknown>;
  runPython(code: string): unknown;
  globals: { get(name: string): (...args: unknown[]) => string };
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
  setStdin(o: { error: boolean }): void;
}

const post = (m: FromWorker) => self.postMessage(m);
let currentId = 0;
const loadedPackages = new Set<string>();

const ready: Promise<Pyodide> = (async () => {
  const mod = await import(/* @vite-ignore */ `${PYODIDE_INDEX}pyodide.mjs`);
  const py: Pyodide = await mod.loadPyodide({ indexURL: PYODIDE_INDEX });
  py.setStdout({ batched: (text) => post({ id: currentId, type: "stdout", text }) });
  py.setStderr({ batched: (text) => post({ id: currentId, type: "stderr", text }) });
  py.setStdin({ error: true }); // input() raises instead of hanging: lessons don't use stdin
  py.runPython(harness);
  return py;
})();

ready.then(
  () => post({ type: "ready" }),
  (e) => post({ type: "load-error", message: String(e?.message ?? e) }),
);

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type !== "run") return;
  const py = await ready;
  currentId = msg.id;
  try {
    const requested = [...new Set(msg.packages ?? [])];
    const unsupported = requested.filter((name) => name.startsWith("_") || !Object.hasOwn(packages, name));
    if (unsupported.length) throw new Error(`Unsupported lesson packages: ${unsupported.join(", ")}`);
    const missing = requested.filter((name) => !loadedPackages.has(name));
    if (missing.length) {
      post({ id: msg.id, type: "packages-loading" });
      await py.loadPackage(missing);
      missing.forEach((name) => loadedPackages.add(name));
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
  const result = JSON.parse(runJson(msg.code, JSON.stringify(msg.tests)));
  post({ id: msg.id, type: "result", result });
};
