/**
 * Turns what happened in the UI (an exercise run, a submitted quiz, a review answer) into learner events.
 * Attribution rule: an exercise or quiz counts for the concepts it checks directly; a lesson concept that none of the
 * lesson's exercises (or quizzes) checks directly is credited with that task's overall result, so every concept can
 * gather evidence. Pure functions, so the rules are testable without the browser.
 */
import { isExercise, type ExerciseStep, type Lesson, type QuizQuestion, type QuizStep } from "../content/types";
import { POLICY_VERSION, type Assistance, type LearnerEvent } from "./model";

export interface Stamp {
  at: string;
  /** Returns a fresh unique id for each event. */
  id: () => string;
}

const testedBy = (lesson: Lesson) =>
  new Set(lesson.steps.filter(isExercise).flatMap((s) => s.tests.map((t) => t.concept)).filter((c): c is string => !!c));
const askedBy = (lesson: Lesson) =>
  new Set(lesson.steps.flatMap((s) => (s.kind === "quiz" ? s.questions.map((q) => q.concept) : [])));

/**
 * `results` lists each check's concept and outcome; `null` means the code didn't run (every concept counts as failed).
 */
export function exerciseEvents(lesson: Lesson, step: ExerciseStep, results: { concept?: string; passed: boolean }[] | null,
                               assistance: Assistance, stamp: Stamp): LearnerEvent[] {
  const lessonConcepts = new Set(lesson.concepts);
  const direct = [...new Set(step.tests.map((t) => t.concept).filter((c): c is string => !!c && lessonConcepts.has(c)))];
  const untested = lesson.concepts.filter((c) => !testedBy(lesson).has(c));
  const overall = results !== null && results.length === step.tests.length && results.every((r) => r.passed);
  const outcome = (c: string) => results !== null && results.filter((r) => r.concept === c).length > 0
    && results.filter((r) => r.concept === c).every((r) => r.passed);
  return [...direct.map((c) => [c, outcome(c)] as const), ...untested.map((c) => [c, overall] as const)].map(([concept, passed]) => ({
    id: stamp.id(), at: stamp.at, lessonId: lesson.id, stepId: step.id, task: "exercise" as const, concept, passed, assistance, policy: POLICY_VERSION,
  }));
}

/**
 * `correct[i]` says whether question i was answered correctly. `assistance` is 4 once this quiz's answers have been
 * revealed by an earlier submission: a retry can still pass the step, but it is no longer an independent explanation check.
 */
export function quizEvents(lesson: Lesson, step: QuizStep, correct: boolean[], stamp: Stamp, assistance: Assistance = 0): LearnerEvent[] {
  const lessonConcepts = new Set(lesson.concepts);
  const byConcept = new Map<string, boolean>();
  step.questions.forEach((q, i) => {
    if (lessonConcepts.has(q.concept)) byConcept.set(q.concept, (byConcept.get(q.concept) ?? true) && correct[i] === true);
  });
  const passed = correct.filter(Boolean).length / Math.max(1, step.questions.length) >= step.pass_mark;
  for (const c of lesson.concepts) if (!askedBy(lesson).has(c)) byConcept.set(c, passed);
  return [...byConcept].map(([concept, ok]) => ({
    id: stamp.id(), at: stamp.at, lessonId: lesson.id, stepId: step.id, task: "quiz" as const, concept, passed: ok, assistance, policy: POLICY_VERSION,
  }));
}

export interface ReviewItem {
  concept: string;
  lessonId: string;
  question: QuizQuestion;
}

/**
 * A retrieval question for a concept: one of its own quiz questions (questions about other concepts would test the
 * wrong thing). Concepts without one get no review item: the Review page says so instead of faking retention evidence.
 * `turn` rotates through the candidates so repeated reviews don't always ask the same thing.
 */
export function reviewItem(lessons: Lesson[], concept: string, turn: number): ReviewItem | null {
  const lesson = lessons.find((l) => l.concepts.includes(concept));
  if (!lesson) return null;
  const pool = lesson.steps.flatMap((s) => (s.kind === "quiz" ? s.questions : [])).filter((q) => q.concept === concept);
  if (pool.length === 0) return null;
  return { concept, lessonId: lesson.id, question: pool[((turn % pool.length) + pool.length) % pool.length]! };
}

export function reviewEvent(item: ReviewItem, correct: boolean, stamp: Stamp): LearnerEvent {
  return { id: stamp.id(), at: stamp.at, lessonId: item.lessonId, stepId: `review:${item.question.id}`, task: "review",
    concept: item.concept, passed: correct, assistance: 0, policy: POLICY_VERSION };
}

/** Assistance level for an exercise attempt: hints seen (at most 3), or 4 once the solution was shown. */
export const assistanceFor = (hintsShown: number, solutionShown: boolean): Assistance =>
  solutionShown ? 4 : (Math.max(0, Math.min(3, Math.floor(hintsShown))) as Assistance);
