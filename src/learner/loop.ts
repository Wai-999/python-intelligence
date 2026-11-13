/**
 * The double-loop part of the feedback controller (master prompt §6). The micro loop is the tutor note on every failed
 * run; this module decides when to step back (the meso loop): after repeated *structural* errors on a concept, after code
 * that works but can't yet be explained (an explanation mismatch), or after repeated reliance on strong hints. Slips (a
 * syntax error, a misspelt name) are recorded but never trigger it, cooldowns keep it from repeating, and every decision
 * is logged with its policy version and the events that triggered it.
 * Pure functions, so the rules are testable without the browser. */
import { isExercise, type ExerciseStep, type Lesson } from "../content/types";
import type { PyError } from "../py/protocol";
import { ordered, SLIP_TAG_PREFIX, type LearnerEvent, type LearnerModel } from "./model";
import { creditedConcepts, type Stamp } from "./record";

export const LOOP_POLICY = "loop-1";
/** Starting hypotheses, not constants of nature (master prompt): ≥3 similar errors within 5 relevant attempts. */
export const MESO = { window: 5, similar: 3, strongHelp: 3, explainMisses: 2, cooldownMs: 10 * 60_000 } as const;

// ---- Classifying a failed run -------------------------------------------------------------------------------------

/**
 * CPython 3.12's built-in names, without exceptions and dunders (dir(builtins)), grouped by kind.
 * tests/test_loop_builtins.py checks this list against the real interpreter.
 */
export const PY_BUILTINS = [
  // constants
  "True", "False", "None", "Ellipsis", "NotImplemented",
  // types and constructors
  "int", "float", "complex", "bool", "str", "bytes", "bytearray", "memoryview", "list", "tuple", "dict", "set", "frozenset",
  "range", "slice", "object", "type", "property", "classmethod", "staticmethod", "super",
  // numbers
  "abs", "round", "pow", "divmod", "sum", "min", "max", "hex", "oct", "bin", "hash", "id",
  // sequences and iteration
  "len", "sorted", "reversed", "enumerate", "zip", "map", "filter", "iter", "next", "aiter", "anext", "all", "any",
  // text
  "chr", "ord", "ascii", "repr", "format", "print", "input",
  // objects and attributes
  "isinstance", "issubclass", "callable", "getattr", "setattr", "hasattr", "delattr", "vars", "dir",
  // execution and environment
  "eval", "exec", "compile", "globals", "locals", "open", "breakpoint", "help", "exit", "quit", "copyright", "credits", "license",
];

/**
 * The code with string literals and comments blanked out, so words inside them are never taken for names (a prefix
 * letter such as f or rb may remain; it can never stand where a name is bound). One left-to-right scan, as Python's
 * tokenizer reads it: a quote inside a comment, or triple quotes inside an ordinary string, start nothing. Newlines are
 * kept, so line structure is unchanged.
 */
export function codeOnly(code: string): string {
  let out = "";
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  for (let i = 0; i < code.length;) {
    const ch = code[i]!;
    if (ch === "#") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      out += blank(code.slice(i, stop));
      i = stop;
    } else if (ch === "'" || ch === '"') {
      const triple = code.startsWith(ch.repeat(3), i);
      let j = i + (triple ? 3 : 1);
      while (j < code.length) {
        if (code[j] === "\\") { j += 2; continue; }
        if (triple ? code.startsWith(ch.repeat(3), j) : code[j] === ch) { j += triple ? 3 : 1; break; }
        if (!triple && code[j] === "\n") break; // an unterminated string ends at the line
        j++;
      }
      out += blank(code.slice(i, j));
      i = j;
    } else { out += ch; i++; }
  }
  return out;
}

const KEYWORDS = new Set(("and as assert async await break class continue def del elif else except finally for from global if import "
  + "in is lambda match case nonlocal not or pass raise return try while with yield").split(" "));
const IDENT = /^[A-Za-z_]\w*$/;

/**
 * Python's logical lines: physical lines joined while brackets are open or after a trailing backslash, so a call or a
 * `def` written over several lines is read as one statement. Expects code with strings and comments blanked.
 */
export function logicalLines(src: string): string[] {
  const lines: string[] = [];
  let depth = 0, current = "";
  for (const physical of src.split("\n")) {
    current += (current ? " " : "") + physical.replace(/\\\s*$/, "");
    for (const ch of physical) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && !/\\\s*$/.test(physical)) { lines.push(current); current = ""; }
  }
  if (current) lines.push(current);
  return lines;
}

/** The text inside the parentheses that open at `open` (balanced), or the rest of the text if they never close. */
function insideParens(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const COMPOUND = /^(?:if|elif|else|for|while|def|class|with|try|except|finally|async\s+(?:for|with|def))\b/;

/**
 * The simple statements of a logical line: split at top-level semicolons, and after a compound statement's header colon
 * (`if ready: total = 0`, `for x in xs: acc = x`), so assignments in a one-line suite are seen.
 */
export function statements(line: string): string[] {
  const out: string[] = [];
  for (const part of splitTop(line, ";")) {
    const stmt = part.trim();
    if (!stmt) continue;
    const colon = COMPOUND.test(stmt) ? topLevelColon(stmt) : -1;
    if (colon === -1) { out.push(stmt); continue; }
    out.push(stmt.slice(0, colon + 1));
    out.push(...statements(stmt.slice(colon + 1)));
  }
  return out;
}

/** The first colon outside brackets that isn't part of `:=`, or -1. */
function topLevelColon(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0 && text[i + 1] !== "=") return i;
  }
  return -1;
}

/** Splits `text` at `sep` characters that aren't inside brackets. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === sep) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Positions of assignment `=` at bracket depth 0 (not ==, !=, <=, >=, :=). An `=` inside brackets is a keyword
 * argument or default: with two of them (`f(a=1, b=2)`) the text between would otherwise look like a target `1, b`.
 */
function assignmentSplits(line: string): number[] {
  const at: number[] = [];
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === "=" && depth === 0 && line[i + 1] !== "=" && !"=!<>:".includes(line[i - 1] ?? "")) at.push(i);
  }
  return at;
}

/** The names a target list binds: `a`, `a, b`, `[a, *rest]`, `(a, (b, c))`; subscriptions and attributes bind nothing. */
function targetNames(target: string, into: Set<string>) {
  for (let part of splitTop(target, ",")) {
    part = part.trim().replace(/^\*/, "").trim();
    const wrapped = /^[([]([\s\S]*)[)\]]$/.exec(part);
    if (wrapped && splitTop(part.slice(1, -1), ",").length >= 1 && !/^[A-Za-z_]\w*\s*\[/.test(part)) { targetNames(wrapped[1]!, into); continue; }
    if (IDENT.test(part) && !KEYWORDS.has(part)) into.add(part);
  }
}

/** Names the code binds: assignment, annotation, loop and comprehension targets, walrus names, functions and their
 *  parameters, lambda parameters, classes, the names imports bind, `with`/`except ... as`, and global/nonlocal. */
export function boundNames(code: string): Set<string> {
  const src = codeOnly(code);
  const names = new Set<string>();
  for (const line of logicalLines(src).flatMap(statements)) {
    if (!line) continue;
    // import a.b as c, d  ->  c, d (Python binds the alias, or the first part of a dotted name)
    let m = /^import\s+(.+)$/.exec(line);
    if (m) {
      for (const part of m[1]!.split(",")) {
        const alias = /\bas\s+([A-Za-z_]\w*)\s*$/.exec(part);
        const first = /^\s*([A-Za-z_]\w*)/.exec(part);
        if (alias) names.add(alias[1]!); else if (first) names.add(first[1]!);
      }
      continue;
    }
    // from m import a, b as c  ->  a, c
    m = /^from\s+[\w.]+\s+import\s+\(?([^)]*)\)?$/.exec(line);
    if (m) {
      for (const part of m[1]!.split(",")) {
        const alias = /\bas\s+([A-Za-z_]\w*)\s*$/.exec(part);
        const name = /^\s*([A-Za-z_]\w*)\s*$/.exec(part);
        if (alias) names.add(alias[1]!); else if (name) names.add(name[1]!);
      }
      continue;
    }
    if (/^(?:with|except)\b/.test(line) || /^async\s+with\b/.test(line))
      for (const a of line.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) names.add(a[1]!);
    for (const g of line.matchAll(/^(?:global|nonlocal)\s+(.+)$/g)) targetNames(g[1]!, names);
    for (const d of line.matchAll(/\bdef\s+([A-Za-z_]\w*)\s*\(/g)) {
      names.add(d[1]!);
      for (const p of splitTop(insideParens(line, d.index! + d[0].length - 1), ",")) {
        const n = /^\s*\**\s*([A-Za-z_]\w*)/.exec(p);
        if (n) names.add(n[1]!);
      }
    }
    for (const c of line.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)) names.add(c[1]!);
    for (const f of line.matchAll(/\bfor\s+(.+?)\s+in\b/g)) targetNames(f[1]!, names);
    for (const l of line.matchAll(/\blambda\s+([^:]*):/g)) for (const p of splitTop(l[1]!, ",")) {
      const n = /^\s*\**\s*([A-Za-z_]\w*)/.exec(p); if (n) names.add(n[1]!);
    }
    for (const w of line.matchAll(/([A-Za-z_]\w*)\s*:=/g)) names.add(w[1]!);
    if (/^(?:if|elif|while|return|assert|del|raise|yield)\b/.test(line)) continue;
    // Assignment: every segment before the last top-level "=" is a target (a = b = 0); "x: int = 0" and "x: int" too.
    const splits = assignmentSplits(line);
    const segments = splits.length ? [line.slice(0, splits[0]!), ...splits.slice(1).map((p, k) => line.slice(splits[k]! + 1, p))] : [];
    const augmented = /^([A-Za-z_]\w*)\s*(?:[-+*/%&|^@]|\/\/|\*\*|<<|>>)=/.exec(line);
    if (augmented) { names.add(augmented[1]!); continue; }
    const annotated = /^([A-Za-z_]\w*)\s*:(?!=)/.exec(line);
    if (annotated && !KEYWORDS.has(annotated[1]!)) { names.add(annotated[1]!); continue; }
    for (const seg of segments) targetNames(seg, names);
  }
  return names;
}

/** Optimal string alignment distance (Levenshtein plus adjacent swaps). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
  }
  return d[a.length]![b.length]!;
}

/**
 * True when an undefined name looks like a misspelling of a name the code binds (within 1 edit for names up to 4
 * letters, 2 for longer ones) or of a built-in (within 1 edit), or differs from one only in case. Words in strings,
 * comments and attribute names (`.values`) don't count: they aren't names the learner could have meant.
 */
export function looksLikeTypo(name: string, code: string): boolean {
  const near = (k: string, limit: number) => k !== name && (k.toLowerCase() === name.toLowerCase() || (k.length > 1 && editDistance(name, k) <= limit));
  const limit = name.length <= 4 ? 1 : 2;
  return [...boundNames(code)].some((k) => near(k, limit)) || PY_BUILTINS.some((k) => near(k, 1));
}

/**
 * Diagnostic tags for a failed run of the learner's code (never for an infrastructure failure, which records nothing).
 * "slip:syntax" / "slip:name" are surface slips; "error:<Type>" is a runtime error of another kind, including a NameError
 * that isn't a near-miss (using a name before it exists). Failed checks are tagged per concept by exerciseEvents.
 */
export function classifyError(error: PyError, code: string): string[] {
  if (error.type === "SyntaxError" || error.type === "IndentationError" || error.type === "TabError") return [`${SLIP_TAG_PREFIX}syntax`];
  if (error.type === "NameError") {
    const name = /name '([^']+)' is not defined/.exec(error.message)?.[1];
    if (name && looksLikeTypo(name, code)) return [`${SLIP_TAG_PREFIX}name`];
  }
  return [`error:${error.type}`];
}

// ---- The meso trigger ---------------------------------------------------------------------------------------------

export interface Intervention {
  kind: "counterexample" | "explanation" | "independence";
  concept: string;
  /** The repeated structural tag (e.g. "error:TypeError", "check:loops"), "explain:mismatch", or "help:strong". */
  signature: string;
  /** Ids of the attempts that triggered it. */
  supports: string[];
}

/**
 * The meso intervention for `concept`, if one is due at `nowMs`. The relevant decisions are those on this concept and
 * those on the task being worked on (`task`, "lessonId:stepId"): one attempt is credited to several concepts with the
 * same error tags, so a step back for one of them covers the others. Only attempts after the last relevant decision
 * count (so the same evidence never triggers twice), and none is offered within MESO.cooldownMs of it.
 */
export function mesoTrigger(events: readonly LearnerEvent[], concept: string, nowMs: number, task?: string): Intervention | null {
  const all = ordered(events);
  const lastDecision = all.filter((e) => e.task === "intervention" && (e.concept === concept || `${e.lessonId}:${e.stepId}` === task)).at(-1);
  const mine = all.filter((e) => e.concept === concept && e.task === "exercise");
  if (lastDecision && nowMs - Date.parse(lastDecision.at) < MESO.cooldownMs) return null;
  const since = lastDecision ? Date.parse(lastDecision.at) : -Infinity;
  const recent = mine.filter((e) => Date.parse(e.at) > since).slice(-MESO.window);

  const counts = new Map<string, LearnerEvent[]>();
  for (const e of recent) {
    if (e.passed) continue;
    for (const tag of new Set(e.tags ?? [])) {
      if (tag.startsWith(SLIP_TAG_PREFIX)) continue; // a repeated typo is not a misconception
      counts.set(tag, [...(counts.get(tag) ?? []), e]);
    }
  }
  const repeated = [...counts].filter(([, es]) => es.length >= MESO.similar)
    .sort((a, b) => b[1].length - a[1].length || Date.parse(b[1].at(-1)!.at) - Date.parse(a[1].at(-1)!.at));
  if (repeated.length > 0) {
    const [signature, es] = repeated[0]!;
    return { kind: "counterexample", concept, signature, supports: es.map((e) => e.id) };
  }
  // Explanation mismatch: the code works (an independent exercise success) but explaining the same concept fails
  // repeatedly (quiz or review answers), so the working code may rest on a mental model that doesn't hold.
  const coded = recent.filter((e) => e.passed && e.assistance === 0);
  const misses = all.filter((e) => e.concept === concept && (e.task === "quiz" || e.task === "review") && Date.parse(e.at) > since)
    .slice(-MESO.window).filter((e) => !e.passed);
  if (coded.length > 0 && misses.length >= MESO.explainMisses)
    return { kind: "explanation", concept, signature: "explain:mismatch", supports: ordered([...coded, ...misses]).map((e) => e.id) };
  const leaned = recent.filter((e) => e.passed && e.assistance >= MESO.strongHelp);
  if (leaned.length >= MESO.similar) return { kind: "independence", concept, signature: "help:strong", supports: leaned.map((e) => e.id) };
  return null;
}

/** Outcome of a shown intervention: shown, the learner worked through it, or postponed it ("Not now"). */
export type Outcome = "shown" | "answered" | "postponed";

/** The decision log entry for an intervention (never evidence of learning; the model skips it). */
export function interventionEvent(i: Intervention, lessonId: string, stepId: string, outcome: Outcome, stamp: Stamp): LearnerEvent {
  return { id: stamp.id(), at: stamp.at, lessonId, stepId, task: "intervention", concept: i.concept, passed: outcome === "answered",
    assistance: 0, policy: LOOP_POLICY, tags: ["loop:meso", `kind:${i.kind}`, `signature:${i.signature}`, `outcome:${outcome}`], supports: [...i.supports] };
}

// ---- The evidence check: an independent transfer task ------------------------------------------------------------

export interface Target { lessonId: string; stepIndex: number; title: string }

/**
 * A different exercise for the concept, not yet solved independently and with no help recorded on it (help stays
 * counted when a task is reopened, so such a task could never give independent evidence), to try without hints after
 * an intervention: the master prompt's "novel transfer task without hints". The current lesson first, then the others.
 * `assistance` is the recorded help per "lessonId:stepId". Null when no such task is left.
 */
export function transferTarget(lessons: readonly Lesson[], model: LearnerModel, concept: string, lessonId: string, stepId: string,
                               assistance: Readonly<Record<string, number>>): Target | null {
  const solved = new Set(model.concepts.get(concept)?.independentTasks ?? []);
  const order = [...lessons].sort((a, b) => (a.id === lessonId ? -1 : b.id === lessonId ? 1 : 0));
  for (const l of order) {
    for (const [stepIndex, s] of l.steps.entries()) {
      const key = `${l.id}:${s.id}`;
      if (!isExercise(s) || (l.id === lessonId && s.id === stepId) || solved.has(key) || (Object.hasOwn(assistance, key) && assistance[key]! > 0)) continue;
      if (creditedConcepts(l, s as ExerciseStep).includes(concept)) return { lessonId: l.id, stepIndex, title: s.title };
    }
  }
  return null;
}
