/**
 * Lesson content schema. Lessons live in content/lessons/<id>.json and are validated at build time
 * by scripts/validate_content.py (schema, graph, and every code snippet executed with CPython).
 *
 * Teaching arc required by MASTER_ARCHITECTURE.md, in order:
 *   motivation -> intuition -> visual -> formal -> example -> guided -> challenge -> quiz -> summary
 */

export type StepKind =
  | "motivation"
  | "intuition"
  | "visual"
  | "formal"
  | "example"
  | "guided"
  | "challenge"
  | "quiz"
  | "summary";

export const STEP_ORDER: readonly StepKind[] = [
  "motivation", "intuition", "visual", "formal", "example", "guided", "challenge", "quiz", "summary",
];

/** Body text uses a small, safe Markdown subset rendered without innerHTML (see components/Prose). */
type Prose = string;

export interface SourceRef {
  /** Must match a source_id in docs/audit/source_manifest.json with internal extraction allowed. */
  source_id: string;
  pages: [number, number];
  note?: string;
}

export interface Socratic {
  /** Questions the offline tutor asks before revealing hints. */
  questions: string[];
}

interface BaseStep {
  id: string;
  kind: StepKind;
  title: string;
  body: Prose;
  socratic?: Socratic;
}

export interface TraceFrame {
  /** 1-based line in `code` that is executing. */
  line: number;
  /** Variables visible in the active frame, as display strings. */
  locals: Record<string, string>;
  /** Call stack, outermost first, e.g. ["<module>", "area(3, 4)"]. */
  stack: string[];
  note: string;
  output?: string;
}

export interface VisualStep extends BaseStep {
  kind: "visual";
  visual: { type: "call-trace"; code: string; frames: TraceFrame[] };
}

export interface ExampleStep extends BaseStep {
  kind: "example";
  code: string;
  /** Expected stdout; checked by the content validator. */
  expected_output: string;
}

export interface PyTest {
  name: string;
  /** Python run in the learner's namespace after their code; must raise AssertionError to fail. */
  code: string;
  /** Concept id to remediate if this test fails repeatedly. */
  concept?: string;
}

export interface ExerciseStep extends BaseStep {
  kind: "guided" | "challenge";
  starter: string;
  hints: string[];
  tests: PyTest[];
  /** Reference solution; must pass all tests. The starter must fail at least one. */
  solution: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  /** Optional code shown with the question. */
  code?: string;
  choices: string[];
  answer: number;
  explanation: string;
  concept: string;
}

export interface QuizStep extends BaseStep {
  kind: "quiz";
  questions: QuizQuestion[];
  /** Fraction correct needed to pass, 0..1. */
  pass_mark: number;
}

export interface ProseStep extends BaseStep {
  kind: "motivation" | "intuition" | "formal" | "summary";
}

export type Step = ProseStep | VisualStep | ExampleStep | ExerciseStep | QuizStep;

export interface Lesson {
  id: string;
  title: string;
  summary: string;
  track: "python-core" | "data" | "statistics" | "ml" | "projects";
  level: 1 | 2 | 3 | 4 | 5;
  estimated_minutes: number;
  prerequisites: string[];
  /** Concepts this lesson teaches (used for remediation lookups). */
  concepts: string[];
  sources: SourceRef[];
  /** License of this lesson's prose and code. */
  license: string;
  steps: Step[];
}

export const isExercise = (s: Step): s is ExerciseStep => s.kind === "guided" || s.kind === "challenge";
export const isGraded = (s: Step) => isExercise(s) || s.kind === "quiz";
