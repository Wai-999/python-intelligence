import { afterEach, describe, expect, it } from "vitest";
import { openProgressStore } from "./store";
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
    const invalid = structuredClone(before);
    // An extra uncloneable property passes field validation but makes IndexedDB put fail.
    Object.assign(invalid.lessons[0]!, { uncloneable: () => undefined });
    await expect(store.importAll(invalid)).rejects.toThrow();
    expect(contents(await store.exportAll())).toEqual(contents(before));
  });

  it("rejects operations on a closed connection", async () => {
    const store = await open();
    store.close();
    await expect(store.allLessons()).rejects.toThrow();
    await expect(store.putLesson(lesson)).rejects.toThrow();
  });
});
