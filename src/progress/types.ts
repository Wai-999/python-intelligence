/** Learner progress model persisted in IndexedDB. No cross-device sync: export/import only. */
import type { LearnerEvent } from "../learner/model";

export const EXPORT_FORMAT = "python-intelligence-progress";
/** Version 2 adds the learner event log; version 1 files still import (with no events). */
export const EXPORT_VERSION = 2;
export const IMPORTABLE_VERSIONS = [1, 2] as const;

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
  /** Append-only learner event log (src/learner/model.ts). */
  events: LearnerEvent[];
  /** Highest help seen per exercise, keyed `${lessonId}:${stepId}` (0..4, see learner/model Assistance). */
  assistance: Record<string, number>;
}

export interface ProgressStore {
  getLesson(lessonId: string): Promise<LessonProgress | undefined>;
  allLessons(): Promise<LessonProgress[]>;
  putLesson(p: LessonProgress): Promise<void>;
  getDraft(lessonId: string, stepId: string): Promise<string | undefined>;
  putDraft(lessonId: string, stepId: string, code: string): Promise<void>;
  getPosition(): Promise<Position | null>;
  setPosition(lessonId: string, stepIndex: number): Promise<void>;
  /** Validates, then stores; re-adding an identical event is a no-op, a different event with a used id is rejected. */
  appendEvents(events: LearnerEvent[]): Promise<void>;
  allEvents(): Promise<LearnerEvent[]>;
  /** Help seen on an exercise so far (0 if none). It only ever goes up, so reopening a task can't hide earlier help. */
  getAssistance(lessonId: string, stepId: string): Promise<number>;
  raiseAssistance(lessonId: string, stepId: string, level: number): Promise<void>;
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
