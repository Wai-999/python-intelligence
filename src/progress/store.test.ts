import { afterEach, describe, expect, it, vi } from "vitest";
import { openProgressStore, ValidationError } from "./store";
import { ImportError, type LessonProgress } from "./types";

const lesson: LessonProgress = {
  lessonId: "functions", steps: { exercise: { passed: true, attempts: 2, score: 1, updatedAt: "2026-01-01T00:00:00.000Z" } },
  furthestStep: 3, completed: true, completedAt: "2026-01-01T00:00:00.000Z", mastery: 0.8, struggles: { calls: 1 },
};
let serial = 0;
const connections: Awaited<ReturnType<typeof openProgressStore>>[] = [];
async function open(name = `progress-test-${Date.now()}-${serial++}`) {
  const store = await openProgressStore(name);
  connections.push(store);
  return store;
}
afterEach(() => { connections.splice(0).forEach((store) => store.close()); });
async function seed(store: Awaited<ReturnType<typeof open>>) {
  await store.putLesson(lesson);
  await store.putDraft("functions", "exercise", "print('hello')");
  await store.setPosition("functions", 3);
}
function contents<T extends { exportedAt: string }>(value: T) {
  const { exportedAt: _, ...rest } = value;
  return rest;
}

describe("IndexedDB progress store", () => {
  it("round-trips lessons, drafts and the exact resume position", async () => {
    const store = await open();
    expect(await store.getLesson("missing")).toBeUndefined();
    expect(await store.getDraft("missing", "step")).toBeUndefined();
    expect(await store.getPosition()).toBeNull();
    await seed(store);
    expect(await store.getLesson("functions")).toEqual(lesson);
    expect(await store.allLessons()).toEqual([lesson]);
    expect(await store.getDraft("functions", "exercise")).toBe("print('hello')");
    expect(await store.getPosition()).toEqual({ lessonId: "functions", stepIndex: 3, updatedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse((await store.getPosition())!.updatedAt))).toBe(true);
  });

  it("persists after closing and reopening", async () => {
    const name = `reopen-${Date.now()}-${serial++}`;
    const first = await open(name);
    await seed(first);
    const before = await first.exportAll();
    first.close();
    const second = await open(name);
    expect(contents(await second.exportAll())).toEqual(contents(before));
  });

  it("exports JSON, clears, and restores all data, replacing existing records", async () => {
    const store = await open();
    await seed(store);
    const saved = JSON.parse(JSON.stringify(await store.exportAll()));
    await store.clear();
    expect(await store.allLessons()).toEqual([]);
    expect(await store.getPosition()).toBeNull();
    expect(await store.getDraft("functions", "exercise")).toBeUndefined();
    await store.putLesson({ ...lesson, lessonId: "obsolete" });
    await store.putDraft("obsolete", "step", "old");
    await store.importAll(saved);
    expect(contents(await store.exportAll())).toEqual(contents(saved));
    await store.importAll({ ...saved, lessons: [], drafts: {}, position: null });
    expect(await store.allLessons()).toEqual([]);
    expect(await store.getPosition()).toBeNull();
  });

  it.each([
    ["format", (p: any) => { p.format = "wrong"; }],
    ["version", (p: any) => { p.version = 99; }],
    ["mastery", (p: any) => { p.lessons[0].mastery = 2; }],
    ["drafts", (p: any) => { p.drafts.bad = 12; }],
    ["attempts", (p: any) => { p.lessons[0].steps.exercise.attempts = -1; }],
    ["passed", (p: any) => { p.lessons[0].steps.exercise.passed = "yes"; }],
    ["score", (p: any) => { p.lessons[0].steps.exercise.score = NaN; }],
    ["furthestStep", (p: any) => { p.lessons[0].furthestStep = 1.5; }],
    ["struggles", (p: any) => { p.lessons[0].struggles.calls = -1; }],
    ["updatedAt", (p: any) => { p.position.updatedAt = "yesterday"; }],
    ["stepIndex", (p: any) => { p.position.stepIndex = -1; }],
    ["completed", (p: any) => { delete p.lessons[0].completed; }],
    ["exportedAt", (p: any) => { delete p.exportedAt; }],
    ["lessonId", (p: any) => { p.lessons.push(p.lessons[0]); }],
  ])("rejects invalid %s without changing any data", async (field, mutate) => {
    const store = await open();
    await seed(store);
    const before = await store.exportAll();
    const invalid = structuredClone(before);
    mutate(invalid);
    await expect(store.importAll(invalid)).rejects.toThrow(ImportError);
    await expect(store.importAll(invalid)).rejects.toThrow(field);
    expect(contents(await store.exportAll())).toEqual(contents(before));
  });

  it.each([null, undefined, 42, "garbage", [], {}])("rejects garbage payload %j", async (data) => {
    const store = await open();
    await seed(store);
    const before = await store.exportAll();
    await expect(store.importAll(data)).rejects.toBeInstanceOf(ImportError);
    expect(contents(await store.exportAll())).toEqual(contents(before));
  });

  it("rolls back every store when a write fails during import", async () => {
    const store = await open();
    await seed(store);
    const before = await store.exportAll();
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (++calls === 2) throw new Error("Injected write failure");
      return original.apply(this, args);
    });
    try {
      await expect(store.importAll(before)).rejects.toThrow("Injected write failure");
    } finally { spy.mockRestore(); }
    expect(contents(await store.exportAll())).toEqual(contents(before));
  });

  it("rejects invalid writes without changing data and preserves export/import compatibility", async () => {
    const store = await open();
    await seed(store);
    const before = await store.exportAll();
    for (const patch of [{ mastery: 2 }, { mastery: NaN }, { furthestStep: -1 },
      { completed: "yes" }, { steps: { bad: { passed: true, attempts: -1, updatedAt: "bad" } } },
      { struggles: { calls: -1 } }, { completedAt: "bad" }, { lessonId: "" }]) {
      await expect(store.putLesson({ ...lesson, ...patch } as LessonProgress)).rejects.toThrow(ValidationError);
    }
    await expect(store.setPosition("functions", -1)).rejects.toThrow("stepIndex");
    await expect(store.setPosition("", 0)).rejects.toThrow("lessonId");
    await expect(store.putDraft("functions", "exercise", 123 as unknown as string)).rejects.toThrow("string");
    expect(contents(await store.exportAll())).toEqual(contents(before));
    // importAll runs the full validator: both raw and JSON exports must be accepted.
    for (const saved of [before, JSON.parse(JSON.stringify(before))]) {
      await store.clear();
      await store.importAll(saved);
      expect(contents(await store.exportAll())).toEqual(contents(before));
    }
  });

  it("stores normalized snapshots on direct writes and imports, reading getters once", async () => {
    const store = await open();
    const makeLesson = () => {
      let reads = 0;
      return { ...lesson, extra: () => undefined,
        get mastery() { return ++reads === 1 ? 0.8 : 99; },
        steps: { exercise: { ...lesson.steps.exercise!, extra: () => undefined } } };
    };
    await store.putLesson(makeLesson());
    expect(await store.getLesson("functions")).toEqual(lesson);
    const saved = await store.exportAll();
    let positionReads = 0;
    await store.importAll({ ...saved, extra: () => undefined, lessons: [makeLesson()],
      position: { lessonId: "functions", stepIndex: 3, extra: () => undefined,
        get updatedAt() { return ++positionReads === 1 ? lesson.completedAt : "bad"; } } });
    expect(await store.getLesson("functions")).toEqual(lesson);
    expect(await store.getPosition()).toEqual({ lessonId: "functions", stepIndex: 3, updatedAt: lesson.completedAt });
    const exported = await store.exportAll();
    await store.clear();
    await store.importAll(exported);
    expect(contents(await store.exportAll())).toEqual(contents(exported));
  });

  it.each(["bad", ":step", "lesson:"])("rejects unreachable imported draft key %s", async (key) => {
    const store = await open();
    await seed(store);
    const saved = await store.exportAll();
    await expect(store.importAll({ ...saved, drafts: { [key]: "code" } })).rejects.toThrow("lessonId:stepId");
    expect(contents(await store.exportAll())).toEqual(contents(saved));
  });

  it("rejects ambiguous draft identifiers", async () => {
    const store = await open();
    await expect(store.putDraft("a:b", "c", "code")).rejects.toThrow("lessonId");
    await expect(store.putDraft("", "c", "code")).rejects.toThrow("lessonId");
    await expect(store.putDraft("a", "", "code")).rejects.toThrow("stepId");
    await store.putDraft("a", "b:c", "code");
    expect(await store.getDraft("a", "b:c")).toBe("code");
    await store.importAll(await store.exportAll());
  });

  it("rejects stale operations and opening a newer schema with a reload error", async () => {
    const name = `upgrade-${Date.now()}-${serial++}`;
    const store = await open(name);
    await seed(store);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      for (const operation of [() => store.allLessons(),
        () => store.putDraft("functions", "exercise", "after upgrade"),
        () => store.putLesson(lesson), () => store.exportAll()]) {
        await expect(operation()).rejects.toThrow("database upgraded in another tab; reload the page");
      }
      await expect(openProgressStore(name)).rejects.toThrow("database upgraded in another tab; reload the page");
    } finally { upgraded.close(); }
  });

  it("reopens once after the browser closes its connection", async () => {
    const spy = vi.spyOn(indexedDB, "open");
    try {
      const store = await open();
      await seed(store);
      expect(spy.mock.calls[0]![1]).toBe(1);
      const connection = spy.mock.results[0]!.value.result as IDBDatabase;
      connection.close();
      connection.onclose!(new Event("close"));
      const [lessons, position] = await Promise.all([store.allLessons(), store.getPosition()]);
      expect(lessons).toEqual([lesson]);
      expect(position?.stepIndex).toBe(3);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });

  it("round-trips draft step ids containing line terminators", async () => {
    const store = await open();
    for (const step of ["\n", "first\r\nsecond:third", "\u2028\u2029"]) {
      await store.putDraft("functions", step, "code");
      const saved = JSON.parse(JSON.stringify(await store.exportAll()));
      await store.clear();
      await store.importAll(saved);
      expect(await store.getDraft("functions", step)).toBe("code");
    }
  });

  it("distinguishes direct validation errors from import errors", async () => {
    const store = await open();
    for (const operation of [() => store.putLesson({ ...lesson, mastery: 2 }),
      () => store.putDraft("", "step", "code"),
      () => store.putDraft("lesson", "step", 42 as unknown as string),
      () => store.setPosition("lesson", -1)]) {
      await expect(operation()).rejects.toBeInstanceOf(ValidationError);
      await expect(operation()).rejects.not.toBeInstanceOf(ImportError);
    }
    const saved = await store.exportAll();
    await expect(store.importAll({ ...saved, lessons: [{ ...lesson, mastery: 2 }] })).rejects.toBeInstanceOf(ImportError);
    await expect(store.importAll({ ...saved, drafts: { bad: "code" } })).rejects.not.toBeInstanceOf(ValidationError);
  });

  it("reports a blocked open and closes a late connection", async () => {
    const request = new EventTarget() as IDBOpenDBRequest;
    const lateConnection = { close: vi.fn() };
    Object.defineProperty(request, "result", { value: lateConnection });
    const spy = vi.spyOn(indexedDB, "open").mockReturnValue(request);
    try {
      const pending = openProgressStore("blocked-test");
      request.onblocked!(new Event("blocked") as IDBVersionChangeEvent);
      await expect(pending).rejects.toThrow("blocked");
      request.onsuccess!(new Event("success"));
      expect(lateConnection.close).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });

  // Follow-up acceptance gate once the UI shell exists: use real browser IndexedDB
  // to complete -> refresh -> resume at the exact step, and export -> clear -> import.
  it("rejects operations on a closed connection", async () => {
    const store = await open();
    store.close();
    await expect(store.allLessons()).rejects.toThrow();
    await expect(store.putLesson(lesson)).rejects.toThrow();
  });
});
