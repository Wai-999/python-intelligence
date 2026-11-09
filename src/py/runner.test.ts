import { afterEach, expect, it, vi } from "vitest";
import { PythonRunner } from "./runner";
import type { FromWorker, ToWorker } from "./protocol";

class FakeWorker extends EventTarget {
  messages: ToWorker[] = [];
  terminate = vi.fn();
  postMessage(message: ToWorker) { this.messages.push(message); }
  send(data: FromWorker) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
const result = { ok: true, error: null, tests: [] };
async function setup() {
  const worker = new FakeWorker();
  const runner = new PythonRunner(() => worker as unknown as Worker);
  const warm = runner.warm();
  worker.send({ type: "ready" });
  await warm;
  return { runner, worker };
}
afterEach(() => vi.useRealTimers());

it("forwards declared packages and gives downloads a separate timeout", async () => {
  vi.useFakeTimers();
  const { runner, worker } = await setup();
  const pending = runner.run("import pandas", [], { packages: ["numpy", "pandas"], timeoutMs: 100 });
  await Promise.resolve(); await Promise.resolve();
  expect(worker.messages[0]?.packages).toEqual(["numpy", "pandas"]);
  worker.send({ id: 1, type: "packages-loading" });
  await vi.advanceTimersByTimeAsync(500);
  expect(runner.status).toBe("loading-packages");
  worker.send({ id: 1, type: "packages-ready" });
  worker.send({ id: 1, type: "result", result });
  expect((await pending).ok).toBe(true);
  expect(runner.status).toBe("ready");
});

it("times out code after package loading and terminates the interpreter", async () => {
  vi.useFakeTimers();
  const { runner, worker } = await setup();
  const pending = runner.run("while True: pass", [], { timeoutMs: 100 });
  await Promise.resolve(); await Promise.resolve();
  expect(worker.messages[0]?.packages).toEqual([]);
  worker.send({ id: 1, type: "packages-ready" });
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).error?.type).toBe("TimeoutError");
  expect(worker.terminate).toHaveBeenCalled();
});

it("reports package timeout as a retryable load failure", async () => {
  vi.useFakeTimers();
  const { runner, worker } = await setup();
  const pending = runner.run("", [], { packages: ["pandas"], packageTimeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).error?.type).toBe("LoadError");
  expect(worker.terminate).toHaveBeenCalled();
  expect(runner.status).toBe("idle");
});

it("serializes runs so package loading cannot mix output between cells", async () => {
  const { runner, worker } = await setup();
  const first = runner.run("first");
  const second = runner.run("second", [], { packages: ["pandas"] });
  await Promise.resolve(); await Promise.resolve();
  expect(worker.messages).toHaveLength(1);
  worker.send({ id: 1, type: "result", result });
  await first;
  await Promise.resolve(); await Promise.resolve();
  expect(worker.messages).toHaveLength(2);
  worker.send({ id: 2, type: "result", result: { ...result, ok: false, error: {
    type: "LoadError", message: "retry", summary: "retry", line: null,
  } } });
  expect((await second).error?.type).toBe("LoadError");
  expect(runner.status).toBe("ready");
});

it("captures package declarations before a run waits in the queue", async () => {
  const { runner, worker } = await setup();
  const packages = ["numpy"];
  const pending = runner.run("import numpy", [], { packages });
  packages[0] = "pandas";
  await Promise.resolve(); await Promise.resolve();
  expect(worker.messages[0]?.packages).toEqual(["numpy"]);
  worker.send({ id: 1, type: "result", result });
  expect((await pending).ok).toBe(true);
});

it("recovers from a worker crash during package loading with a fresh interpreter", async () => {
  const workers: FakeWorker[] = [];
  const runner = new PythonRunner(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const warm = runner.warm();
  workers[0]!.send({ type: "ready" });
  await warm;
  const pending = runner.run("import pandas", [], { packages: ["pandas"] });
  await Promise.resolve(); await Promise.resolve();
  workers[0]!.send({ id: 1, type: "packages-loading" });
  workers[0]!.dispatchEvent(new ErrorEvent("error", { message: "download worker crashed" }));
  expect((await pending).error?.type).toBe("LoadError");
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(runner.status).toBe("idle");

  const retry = runner.run("import pandas", [], { packages: ["pandas"] });
  await Promise.resolve(); await Promise.resolve();
  expect(workers).toHaveLength(2);
  workers[1]!.send({ type: "ready" });
  await Promise.resolve(); await Promise.resolve();
  expect(workers[1]!.messages[0]?.packages).toEqual(["pandas"]);
  workers[1]!.send({ id: 2, type: "packages-ready" });
  workers[1]!.send({ id: 2, type: "result", result });
  expect((await retry).ok).toBe(true);
});

it("returns package validation errors and allows a corrected run", async () => {
  const { runner, worker } = await setup();
  const pending = runner.run("must not execute", [], { packages: ["_note"] });
  await Promise.resolve(); await Promise.resolve();
  const error = { type: "PackageError", message: "Unsupported lesson packages: _note",
    summary: "Unsupported lesson packages: _note", line: null };
  worker.send({ id: 1, type: "result", result: { ok: false, tests: [], error } });
  expect((await pending).error).toEqual(error);
  expect(runner.status).toBe("ready");
  expect(worker.terminate).not.toHaveBeenCalled();

  const retry = runner.run("print(1)");
  await Promise.resolve(); await Promise.resolve();
  worker.send({ id: 2, type: "packages-ready" });
  worker.send({ id: 2, type: "stdout", text: "1" });
  worker.send({ id: 2, type: "result", result });
  expect(await retry).toMatchObject({ ok: true, stdout: "1\n" });
});
