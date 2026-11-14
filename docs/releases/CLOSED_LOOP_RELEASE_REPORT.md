# Closed-loop release report

Master prompt §15. Every claim below points at code, a test, or a CI run you can re-run. Statuses use the prompt's words:
**DONE**, **PARTIAL**, **BLOCKED**, **UNVERIFIED**.

## Release

| | |
|---|---|
| Deployed URL | https://wai-999.github.io/python-intelligence/ |
| Branch | `main` (every push that passes all gates deploys; owner decision 2026-11-08) |
| Release commit | `a5b126d4473f8df6c9d8ab2b6512d565d7ebf3e2`, verified live. This report was added in the docs-only commit that follows it; `docs/` isn't part of the site, so the published files differ only in their build stamp (`pi-build`). |
| GitHub Actions run | [run 43580113503](https://github.com/Wai-999/python-intelligence/actions/runs/43580113503) (`gates` and `deploy` both green) |
| Live verification | The deploy job waits until the page's `<meta name="pi-build">` equals the pushed SHA, then runs Playwright against the live URL (sub-path load, mobile viewport, keyboard reach, Python running in Pyodide, browser file I/O). Checked again by hand with `curl` on 2026-11-14: the live page serves build `a5b126d4473f8df6c9d8ab2b6512d565d7ebf3e2`. |

## Operating mode: A (static-first)

GitHub Pages serves static files. Python runs in the browser in a dedicated Web Worker (Pyodide 0.27.8, CPython 3.12.7).
Progress lives in IndexedDB in the learner's browser, with export and import as the only way to move it.

- No secret keys, no backend, no remote grader, no LLM. The "tutor" is an **offline guide**: pre-written explanations
  matched to verified run results. The home page says so.
- The worker is isolation for responsiveness, **not a security sandbox** (`src/py/worker.ts`; risk R10). It has a timeout
  that terminates the interpreter, an output cap (100,000 characters per run, G-15), and no access to secrets because
  the page has none.
- All exercise checks ship in the client. There are no hidden tests, so client-side results are learning feedback, not
  certification.

## Feedback loops

| Loop | Status | Evidence |
|---|---|---|
| Micro: execution error, failed check, help request | DONE | Verified failures only: `src/tutor/feedback.ts`; infrastructure errors record no attempt (`INFRASTRUCTURE_ERRORS`); progressive hints by tier (`src/components/Exercise.tsx`). e2e: `exercise-state.spec.ts`, `learner.spec.ts`. |
| Meso: repeated structural errors, explanation mismatch, reliance on strong hints | DONE | `src/learner/loop.ts` (`mesoTrigger`, cooldown 10 min, scoped to the task); typos are classified by Python's own parser and never trigger (`harness.bound_names`); every step back is logged with policy version and supporting event ids. e2e: `loop.spec.ts` ("a repeated typo never triggers a step back, but a repeated structural error does, once"; postponement). |
| Macro: completion, spaced review, delayed retrieval | DONE | `src/learner/model.ts` review schedule 1, 3, 7, 14, 30 days; a failed or assisted review resets the spacing and durable mastery; review page with free-recall prompts. e2e: `review.spec.ts` ("a completed concept comes back after a day, and the spacing grows or resets"). |
| Scaffold fading | DONE | `suggestedTier`: two independent successes ease off one tier, two comparable failures restore one, never past tier 3 without an explicit request. e2e: `scaffold.spec.ts`. |
| Placement diagnostic | DONE | G-12: ordered checkpoints of prediction questions whose outputs the content gate runs in CPython; testing out unlocks later lessons but completes nothing and is never mastery evidence; runs carry a content fingerprint. e2e: `diagnostic.spec.ts`. |

## Persistence and course continuity

- IndexedDB schema v2 with an append-only event log, versioned exports (v1 files still import), and a replacement
  token so a tab built on older progress can't write into an import or reset (`src/progress/store.ts`).
- e2e: "complete lesson 1, refresh mid-lesson 2, resume exactly, get next recommendation"; "export, reset, and import
  restore progress"; "a corrupt import is rejected and leaves progress unchanged"; cross-tab import and reset cases.
- Every lesson recommends a specific next lesson (`recommendNext`), with remediation for repeated failures on a concept
  taught earlier.

## Curriculum

44 lessons across Python fundamentals, data, statistics, ML and projects, in a validated prerequisite graph (no cycles,
no orphans, every concept taught once). Every lesson has the §5 fields: objective, analogy, worked example, prediction
questions, editable exercises with tests, one transfer problem, rubric, misconceptions, estimated duration, next-node
mapping and spaced-review metadata (G-5). Every exercise has a difficulty tag (G-13), and help used is recorded on each
attempt. Five open books are used: three adapted with attribution, two (MML and the Big Book) cited only. No PDF is
published, and a 12-word shingle check keeps book text out of lessons and out of `dist/`.

## Test results at `a5b126d`

| Suite | Result |
|---|---|
| Python (orchestrator, content gate, ingest, rights manifest, transfer variants, diagnostic) | 581 passed, 3 skipped (the live agent-CLI contract tests, which run only with `PI_LIVE=1` and the real CLIs installed) |
| Frontend unit (Vitest) | 206 passed |
| Browser e2e (Playwright, production build under the sub-path) | 126 passed |
| Content gate | 44 lessons and 220 executable steps verified in CPython 3.12; 15 placement questions verified |
| Accessibility | axe-core WCAG 2.1 A/AA on every page state in light and dark mode: no violations |
| Secret scan, dist licence/size gate | clean |

### Master prompt test matrix

| ID | Status | Where |
|---|---|---|
| T01 SyntaxError, T02 IndexError, T03 wrong result | DONE | tutor feedback unit tests; `combined.spec.ts` |
| T04 infinite loop | DONE | "an infinite loop is stopped and Python recovers" |
| T05 huge stdout / memory | DONE | `limits.spec.ts`: output cut at 100,000 characters; `[0] * 10**9` is a MemoryError and Python recovers |
| T06 malicious code or comments | PARTIAL | No secrets exist to reach, and comments never reach a model (there is none). The worker is not a hardened sandbox: see Mode A. |
| T07 three recurring errors, T08 single typo | DONE | `loop.spec.ts`, `src/learner/loop.test.ts` |
| T09 assisted pass, T10 two independent passes | DONE | `src/learner/model.test.ts` |
| T11 delayed retrieval failure | DONE | `review.spec.ts`, model tests |
| T12 save, close, reopen | DONE | `learner.spec.ts` |
| T13 IndexedDB migration | DONE | v1 to v2 store and export tests (`src/progress/store.test.ts`) |
| T14 LLM unavailable | DONE by design | There is no LLM; the offline guide is deterministic and labelled as such. |
| T15 hidden tests absent from the bundle | N/A | There are no hidden tests; every check is public and stated as such. |
| T16 prompt injection in code | N/A | No model reads learner code. |
| T17 deep link on Pages | DONE | smoke test on the live URL |
| T18 mobile, keyboard, screen reader | DONE (automated) | smoke and a11y specs; manual screen-reader testing **UNVERIFIED** |
| T19 course completion | DONE | recommendation tests and e2e |
| T20 production deploy | DONE | [run 43580113503](https://github.com/Wai-999/python-intelligence/actions/runs/43580113503) |

## BLOCKED, PARTIAL and UNVERIFIED

- **BLOCKED (owner gate G-T):** server-side tutor gateway, structured LLM prompts, cost caps. Needs a separately hosted
  server and API keys. GitHub Pages can't host it, and no keys belong in the client.
- **BLOCKED (Mode B not authorised):** a hardened remote execution service, hidden tests, authenticated sync.
- **PARTIAL:** the browser worker is not a security boundary. That is acceptable for learners running their own code, and
  disclosed on the site.
- **UNVERIFIED:** manual screen-reader passes, and real-user learning outcomes. Every threshold in the learner model is a
  labelled heuristic, not a calibrated probability.
- **Owner decisions still open:** P1-7, P2-6, P3-5, P5-4 (branch protection), G-T (`docs/TASKS.md`).

## Rollback

Every push to `main` that passes the gates deploys, so rolling back is a revert commit:

1. `git revert <bad-sha>` (or a range), then `git push origin main`. Never force-push: history is published.
2. The workflow re-runs every gate and deploys only if they pass, then waits until the live page's `pi-build` equals the
   new SHA.
3. A run that fails any gate deploys nothing, so Pages keeps serving the last build that passed. Fix forward, or revert
   further.

Learner data is unaffected by a rollback: it lives in each browser. Store versions only move forward, and older
exports keep importing.

## Next step with the most value

The owner's decision on G-T. Everything else in the master prompt that a static site can honestly do is in place.
