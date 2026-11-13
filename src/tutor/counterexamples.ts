/**
 * Prediction tasks for the meso loop: a small, original counterexample per structural error class. The learner predicts
 * what the snippet does before seeing the explanation, which surfaces the mental model behind the repeated error.
 * The content lives in content/counterexamples.json, where each entry also states its outcome (raises, prints or runs
 * forever); tests/test_counterexamples.py runs every snippet in CPython and checks that outcome.
 */
import data from "../../content/counterexamples.json";
export interface Counterexample {
  code: string;
  question: string;
  choices: string[];
  answer: number;
  explanation: string;
  /** What the snippet does (checked by running it): it raises this error, prints this, or never stops. */
  outcome: { raises?: string; prints?: string; runsForever?: boolean };
}

const CASES = data as unknown as Record<string, Counterexample>;

/** The prediction task for a repeated structural error, or null (failed checks and other errors get a reflection prompt). */
export function counterexampleFor(signature: string): Counterexample | null {
  return Object.hasOwn(CASES, signature) ? CASES[signature]! : null;
}

export const COUNTEREXAMPLE_SIGNATURES = Object.keys(CASES);
