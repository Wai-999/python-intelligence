import {
  EXPORT_FORMAT, EXPORT_VERSION, ImportError,
  type LessonProgress, type Position, type ProgressExport, type ProgressStore,
} from "./types";

const DB_VERSION = 1;
const RELOAD_MESSAGE = "database upgraded in another tab; reload the page";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const stores = ["lessons", "drafts", "meta"];

type Obj = Record<string, unknown>;
function object(value: unknown, path: string): asserts value is Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${path} must be an object`);
  }
}
function check(valid: boolean, message: string): asserts valid {
  if (!valid) throw new ValidationError(message);
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
function validateLesson(value: unknown, path = "lesson"): LessonProgress {
  object(value, path);
  const { lessonId, steps, furthestStep, completed, completedAt, mastery, struggles } = value;
  check(typeof lessonId === "string" && lessonId.length > 0, `${path}.lessonId must be a nonempty string`);
  integer(furthestStep, `${path}.furthestStep`);
  unit(mastery, `${path}.mastery`);
  check(typeof completed === "boolean", `${path}.completed must be boolean`);
  if (completedAt !== undefined) timestamp(completedAt, `${path}.completedAt`);
  object(steps, `${path}.steps`);
  const normalizedSteps = Object.fromEntries(Object.entries(steps).map(([key, value]) => {
    const stepPath = `${path}.steps.${key}`;
    object(value, stepPath);
    const { passed, attempts, updatedAt, score } = value;
    check(typeof passed === "boolean", `${stepPath}.passed must be boolean`);
    integer(attempts, `${stepPath}.attempts`);
    timestamp(updatedAt, `${stepPath}.updatedAt`);
    if (score !== undefined) unit(score, `${stepPath}.score`);
    return [key, { passed, attempts, updatedAt, ...(score === undefined ? {} : { score }) }];
  }));
  object(struggles, `${path}.struggles`);
  const normalizedStruggles = Object.fromEntries(Object.entries(struggles).map(([key, count]) => {
    integer(count, `${path}.struggles.${key}`);
    return [key, count];
  }));
  // All fields above are validated snapshots; never send the caller's objects to IndexedDB.
  return { lessonId, steps: normalizedSteps, furthestStep, completed,
    ...(completedAt === undefined ? {} : { completedAt }), mastery, struggles: normalizedStruggles } as LessonProgress;
}
function validatePosition(value: unknown): Position {
  object(value, "position");
  const { lessonId, stepIndex, updatedAt } = value;
  check(typeof lessonId === "string" && lessonId.length > 0, "position.lessonId must be a nonempty string");
  integer(stepIndex, "position.stepIndex");
  timestamp(updatedAt, "position.updatedAt");
  return { lessonId, stepIndex, updatedAt } as Position;
}
function validateDraft(key: string, code: unknown): string {
  check(/^[^:]+:[\s\S]+$/.test(key), `drafts.${key} key must be lessonId:stepId`);
  check(typeof code === "string", `drafts.${key} must be a string`);
  return code;
}
function validate(data: unknown): ProgressExport {
  object(data, "payload");
  const { format, version, exportedAt, lessons, drafts, position } = data;
  check(format === EXPORT_FORMAT, "format is not supported");
  check(version === EXPORT_VERSION, "version is not supported");
  timestamp(exportedAt, "exportedAt");
  check(Array.isArray(lessons), "lessons must be an array");
  const ids = new Set<string>();
  const normalizedLessons = lessons.map((value: unknown, i: number) => {
    const lesson = validateLesson(value, `lessons[${i}]`);
    check(!ids.has(lesson.lessonId), `lessons[${i}].lessonId is duplicated`);
    ids.add(lesson.lessonId);
    return lesson;
  });
  object(drafts, "drafts");
  return { format, version, exportedAt: exportedAt as string, lessons: normalizedLessons,
    drafts: Object.fromEntries(Object.entries(drafts).map(([key, code]) => [key, validateDraft(key, code)])),
    position: position === null ? null : validatePosition(position) };
}

export async function openProgressStore(dbName = "python-intelligence"): Promise<ProgressStore & { close(): void }> {
  let db: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;
  let closed = false;
  let stale = false;
  function connect(): Promise<IDBDatabase> {
    if (stale) return Promise.reject(new Error(RELOAD_MESSAGE));
    if (closed) return Promise.reject(new Error("Progress store is closed"));
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        for (const name of stores) {
          if (!request.result.objectStoreNames.contains(name)) {
            request.result.createObjectStore(name, name === "lessons" ? { keyPath: "lessonId" } : undefined);
          }
        }
      };
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        reject(new Error("Progress database opening is blocked; close other tabs and retry"));
      };
      request.onerror = () => {
        if (request.error?.name === "VersionError") {
          stale = true;
          reject(new Error(RELOAD_MESSAGE));
        } else reject(request.error);
      };
      request.onsuccess = () => {
        const connection = request.result;
        if (closed || blocked) { connection.close(); return; }
        db = connection;
        connection.onversionchange = () => {
          stale = true;
          connection.close();
          if (db === connection) db = undefined;
        };
        connection.onclose = () => {
          if (db === connection) db = undefined;
        };
        resolve(connection);
      };
    }).finally(() => { opening = undefined; });
    return opening;
  }
  await connect();

  async function transact<T>(names: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    const connection = await connect();
    return new Promise((resolve, reject) => {
      const tx = connection.transaction(names, mode);
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
    close: () => { closed = true; db?.close(); db = undefined; },
    getLesson: (id) => read<LessonProgress | undefined>("lessons", id),
    allLessons: () => read<LessonProgress[]>("lessons"),
    putLesson: async (lesson) => put("lessons", validateLesson(lesson)),
    getDraft: (lesson, step) => read<string | undefined>("drafts", `${lesson}:${step}`),
    putDraft: async (lesson, step, code) => {
      check(typeof lesson === "string" && lesson.length > 0 && !lesson.includes(":"), "draft lessonId must be nonempty and contain no colon");
      check(typeof step === "string" && step.length > 0, "draft stepId must be a nonempty string");
      const key = `${lesson}:${step}`;
      await put("drafts", validateDraft(key, code), key);
    },
    getPosition: async () => (await read<Position | undefined>("meta", "position")) ?? null,
    setPosition: async (lessonId, stepIndex) => put("meta", validatePosition({ lessonId, stepIndex, updatedAt: new Date().toISOString() }), "position"),
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
      let normalized: ProgressExport;
      try { normalized = validate(data); }
      catch (error) {
        if (error instanceof ValidationError) throw new ImportError(error.message);
        throw error;
      }
      await transact<void>(stores, "readwrite", (tx) => {
        for (const name of stores) tx.objectStore(name).clear();
        for (const lesson of normalized.lessons) tx.objectStore("lessons").put(lesson);
        for (const [key, code] of Object.entries(normalized.drafts)) tx.objectStore("drafts").put(code, key);
        if (normalized.position !== null) tx.objectStore("meta").put(normalized.position, "position");
      });
    },
    clear: () => transact<void>(stores, "readwrite", (tx) => {
      for (const name of stores) tx.objectStore(name).clear();
    }),
  };
}
