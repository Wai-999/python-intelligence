/// <reference lib="webworker" />
// Runs Pyodide off the main thread. NOTE: this is isolation for responsiveness, not a security
// boundary: learner code runs with the page's origin inside the worker (no DOM, no host access).
import harness from "./harness.py?raw";
import { PYODIDE_INDEX, type FromWorker, type ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

interface Pyodide {
  runPython(code: string): unknown;
  globals: { get(name: string): (...args: unknown[]) => string };
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
  setStdin(o: { error: boolean }): void;
}

const post = (m: FromWorker) => self.postMessage(m);
let currentId = 0;

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
  const runJson = py.globals.get("run_json");
  const result = JSON.parse(runJson(msg.code, JSON.stringify(msg.tests)));
  post({ id: msg.id, type: "result", result });
};
