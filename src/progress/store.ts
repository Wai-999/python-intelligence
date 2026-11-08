import {
  EXPORT_FORMAT, EXPORT_VERSION, ImportError,
  type LessonProgress, type Position, type ProgressExport, type ProgressStore,
} from "./types";

const stores = ["lessons", "drafts", "meta"];

type Obj = Record<string, unknown>;
function object(value: unknown, path: string): asserts value is Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportError(`${path} must be an object`);
  }
}
function check(valid: boolean, message: string): asserts valid {
  if (!valid) throw new ImportError(message);
}
function timestamp(value: unknown, path: string) {
  check(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), `${path} must be an ISO timestamp`);
}
function integer(value: unknown, path: string) {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `${path} must be a nonnegative integer`);
}
function unit(value: unknown, path: string) {
  check(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, `${path} must be between 0 and 1`);
}
function validate(data: unknown): asserts data is ProgressExport {
  object(data, "payload");
  check(data.format === EXPORT_FORMAT, "format is not supported");
  check(data.version === EXPORT_VERSION, "version is not supported");
  timestamp(data.exportedAt, "exportedAt");
  check(Array.isArray(data.lessons), "lessons must be an array");
  const ids = new Set<string>();
  data.lessons.forEach((lesson: unknown, i: number) => {
    const path = `lessons[${i}]`;
    object(lesson, path);
    check(typeof lesson.lessonId === "string" && lesson.lessonId.length > 0, `${path}.lessonId must be a nonempty string`);
    check(!ids.has(lesson.lessonId), `${path}.lessonId is duplicated`);
    ids.add(lesson.lessonId);
    integer(lesson.furthestStep, `${path}.furthestStep`);
    unit(lesson.mastery, `${path}.mastery`);
    check(typeof lesson.completed === "boolean", `${path}.completed must be boolean`);
    if (lesson.completedAt !== undefined) timestamp(lesson.completedAt, `${path}.completedAt`);
    object(lesson.steps, `${path}.steps`);
    for (const [key, step] of Object.entries(lesson.steps)) {
      const stepPath = `${path}.steps.${key}`;
      object(step, stepPath);
      check(typeof step.passed === "boolean", `${stepPath}.passed must be boolean`);
      integer(step.attempts, `${stepPath}.attempts`);
      timestamp(step.updatedAt, `${stepPath}.updatedAt`);
      if (step.score !== undefined) unit(step.score, `${stepPath}.score`);
    }
    object(lesson.struggles, `${path}.struggles`);
    for (const [key, count] of Object.entries(lesson.struggles)) integer(count, `${path}.struggles.${key}`);
  });
  object(data.drafts, "drafts");
  for (const [key, code] of Object.entries(data.drafts)) check(typeof code === "string", `drafts.${key} must be a string`);
  if (data.position !== null) {
    object(data.position, "position");
    check(typeof data.position.lessonId === "string" && data.position.lessonId.length > 0, "position.lessonId must be a nonempty string");
    integer(data.position.stepIndex, "position.stepIndex");
    timestamp(data.position.updatedAt, "position.updatedAt");
  }
}

export async function openProgressStore(dbName = "python-intelligence"): Promise<ProgressStore & { close(): void }> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("lessons", { keyPath: "lessonId" });
      request.result.createObjectStore("drafts");
      request.result.createObjectStore("meta");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  db.onversionchange = () => db.close();

  function transact<T>(names: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? new Error("Progress transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Progress transaction aborted"));
      try { work(tx, (next) => { value = next; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  function read<T>(name: string, key?: IDBValidKey): Promise<T> {
    return transact<T>([name], "readonly", (tx, result) => {
      const store = tx.objectStore(name);
      const request = key === undefined ? store.getAll() : store.get(key);
      request.onsuccess = () => result(request.result as T);
    });
  }
  function put(name: string, value: unknown, key?: IDBValidKey): Promise<void> {
    return transact<void>([name], "readwrite", (tx) => { tx.objectStore(name).put(value, key); });
  }
  return {
    close: () => db.close(),
    getLesson: (id) => read<LessonProgress | undefined>("lessons", id),
    allLessons: () => read<LessonProgress[]>("lessons"),
    putLesson: (lesson) => put("lessons", lesson),
    getDraft: (lesson, step) => read<string | undefined>("drafts", `${lesson}:${step}`),
    putDraft: (lesson, step, code) => put("drafts", code, `${lesson}:${step}`),
    getPosition: async () => (await read<Position | undefined>("meta", "position")) ?? null,
    setPosition: (lessonId, stepIndex) => put("meta", { lessonId, stepIndex, updatedAt: new Date().toISOString() }, "position"),
    exportAll: () => transact<ProgressExport>(stores, "readonly", (tx, result) => {
      const output: ProgressExport = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), lessons: [], drafts: {}, position: null };
      const lessons = tx.objectStore("lessons").getAll();
      lessons.onsuccess = () => { output.lessons = lessons.result; };
      const cursor = tx.objectStore("drafts").openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (entry) {
          Object.defineProperty(output.drafts, String(entry.key), { value: entry.value, enumerable: true, configurable: true, writable: true });
          entry.continue();
        }
      };
      const position = tx.objectStore("meta").get("position");
      position.onsuccess = () => { output.position = position.result ?? null; };
      result(output);
    }),
    importAll: async (data) => {
      validate(data);
      await transact<void>(stores, "readwrite", (tx) => {
        for (const name of stores) tx.objectStore(name).clear();
        for (const lesson of data.lessons) tx.objectStore("lessons").put(lesson);
        for (const [key, code] of Object.entries(data.drafts)) tx.objectStore("drafts").put(code, key);
        if (data.position !== null) tx.objectStore("meta").put(data.position, "position");
      });
    },
    clear: () => transact<void>(stores, "readwrite", (tx) => {
      for (const name of stores) tx.objectStore(name).clear();
    }),
  };
}
