/** Learner progress model persisted in IndexedDB. No cross-device sync: export/import only. */

export const EXPORT_FORMAT = "python-intelligence-progress";
export const EXPORT_VERSION = 1;

export interface StepResult {
  /** Exercise: all tests passed. Quiz: score >= pass_mark. Prose/example steps: viewed. */
  passed: boolean;
  attempts: number;
  /** Quiz score 0..1 (quiz steps only). */
  score?: number;
  updatedAt: string; // ISO-8601
}

export interface LessonProgress {
  lessonId: string;
  /** Keyed by step id. */
  steps: Record<string, StepResult>;
  /** Index of the furthest step reached. */
  furthestStep: number;
  completed: boolean;
  completedAt?: string;
  /** 0..1 estimate (see curriculum/mastery.ts). */
  mastery: number;
  /** Failed-test counts per concept id, used for remediation. */
  struggles: Record<string, number>;
}

export interface Position {
  lessonId: string;
  stepIndex: number;
  updatedAt: string;
}

export interface ProgressExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  lessons: LessonProgress[];
  /** Keyed by `${lessonId}:${stepId}`. */
  drafts: Record<string, string>;
  position: Position | null;
}

export interface ProgressStore {
  getLesson(lessonId: string): Promise<LessonProgress | undefined>;
  allLessons(): Promise<LessonProgress[]>;
  putLesson(p: LessonProgress): Promise<void>;
  getDraft(lessonId: string, stepId: string): Promise<string | undefined>;
  putDraft(lessonId: string, stepId: string, code: string): Promise<void>;
  getPosition(): Promise<Position | null>;
  setPosition(lessonId: string, stepIndex: number): Promise<void>;
  exportAll(): Promise<ProgressExport>;
  /** Validates fully BEFORE writing; on invalid input throws ImportError and leaves the store unchanged. */
  importAll(data: unknown): Promise<void>;
  clear(): Promise<void>;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}
