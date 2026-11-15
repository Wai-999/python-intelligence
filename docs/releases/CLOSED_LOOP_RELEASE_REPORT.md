# Closed-loop release report

Master prompt §15. Every claim below points at code, a test, or a CI run you can re-run. Statuses use the prompt's words:
**DONE**, **PARTIAL**, **BLOCKED**, **UNVERIFIED**.

## Release

| | |
|---|---|
| Deployed URL | https://wai-999.github.io/python-intelligence/ |
| Branch | `main` (every push that passes all gates deploys; owner decision 2026-11-08) |
| Release commit | `e05748b774e14e4b96a444f27acda05ae1c054c8`, verified live. This report was brought up to date in the docs-only commit that follows it; `docs/` isn't part of the site, so the published files differ only in their build stamp (`pi-build`). |
| GitHub Actions run | [run 43665292702](https://github.com/Wai-999/python-intelligence/actions/runs/43665292702) (`gates` and `deploy` both green) |
| Live verification | The deploy job waits until the page's `<meta name="pi-build">` equals the pushed SHA, then runs Playwright against the live URL (sub-path load, mobile viewport, keyboard reach, Python running in Pyodide, browser file I/O). Checked again by hand with `curl` on 2026-11-14: the live page serves build `e05748b774e14e4b96a444f27acda05ae1c054c8`. |

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
| Course map and "why" | DONE | G-16: every lesson step says why this lesson (what it builds on, what it opens); the map shows locked, ready, in progress, tested out, completed independently, completed with help, and review due, in words, with icons as decoration. Completion is "independent" only when every graded step has an unaided passing attempt; older data that can't show it is labelled plain "Completed". e2e: `standing.spec.ts`, `review.spec.ts`. |
| Placement diagnostic | DONE | G-12: ordered checkpoints of prediction questions whose outputs the content gate runs in CPython; testing out unlocks later lessons but completes nothing and is never mastery evidence; runs carry a content fingerprint. e2e: `diagnostic.spec.ts`. |

## Persistence and course continuity

- IndexedDB schema v2 with an append-only event log, versioned exports (v1 files still import), and a replacement
  token so a tab built on older progress can't write into an import or reset (`src/progress/store.ts`).
- e2e: "complete lesson 1, refresh mid-lesson 2, resume exactly, get next recommendation"; "export, reset, and import
  restore progress"; "a corrupt import is rejected and leaves progress unchanged"; cross-tab import and reset cases.
- Saved progress is re-judged against today's lessons whenever it is loaded or imported (`reconcile` in
  `src/progress/logic.ts`): completion and mastery are recomputed, so a lesson completed before it gained its transfer
  problem shows as in progress until that problem is solved. e2e: "a completion saved before the lesson gained its
  transfer problem doesn't stand after an import".
- Every lesson recommends a specific next lesson (`recommendNext`), with remediation for repeated failures on a concept
  taught earlier.

## Curriculum

44 lessons across Python fundamentals, data, statistics, ML and projects, in a validated prerequisite graph (no cycles,
no orphans, every concept taught once). Every lesson has the §5 fields: objective, analogy, worked example, prediction
questions, editable exercises with tests, one transfer problem, rubric, misconceptions, estimated duration, next-node
mapping and spaced-review metadata (G-5). Every exercise has a difficulty tag (G-13), and help used is recorded on each
attempt. Codex audited every transfer problem's checks (G-5a: 30 findings, then 21 re-audit rounds, until it found no
further plausible learner mistake that passes). Every mistake the audit found is now rejected, and the valid alternatives
it raised are accepted; 277 rejected and accepted variants in `tests/transfer_variants.json` pin that. Like any finite set
of checks, they can't rule out every possible error. The checks are learning feedback, not anti-cheating: they run in the learner's own browser.
Five open books are used: three adapted with attribution, two (MML and the Big Book) cited only. No PDF is
published, and a 12-word shingle check keeps book text out of lessons and out of `dist/`.

## Test results at `e05748b`

| Suite | Result |
|---|---|
| Python (orchestrator, content gate, ingest, rights manifest, transfer variants, diagnostic, execution tracer) | 772 passed, 3 skipped (the live agent-CLI contract tests, which run only with `PI_LIVE=1` and the real CLIs installed) |
| Frontend unit (Vitest) | 240 passed, including the WCAG contrast, in both schemes, of the tokens that carry state (the strong border, the focus ring and the trace highlight) against every background they sit on |
| Browser e2e (Playwright, production build under the sub-path) | 169 passed, on desktop and, for the smoke and layout specs, a Pixel 7 viewport (and a 320 px one) |
| Content gate | 44 lessons and 220 executable steps verified in CPython 3.12, plus two further worked examples on each of the 45 example steps (all run and compared); 15 placement questions verified |
| Accessibility | axe-core WCAG 2.1 A/AA, no violations, in both light and dark mode (`e2e/a11y.spec.ts`): home, library, every step of a lesson that has all ten step kinds (motivation, intuition with sources and the look-ahead notice, the call-trace viewer, formal, example, guided, challenge, transfer, quiz, recap with further reading), an example with output, failed checks with the tutor note, the suggested-support note, a passed transfer problem, the meso step back (prediction, explanation and transfer link), the progress panel, the Review page with nothing due and with a review due, and the placement check (intro, a checked group, result). Since this report was last updated, scans also run with forced colours (Windows High Contrast) and with more contrast requested, in both schemes, and with a trace of the learner's own code open. Keyboard focus is checked for the progress panel, the Review page, "Try another example" and the phone Menu. Manual screen-reader testing is **UNVERIFIED**. |
| Performance | `dist/` of the release build is 1,386,378 bytes in 5 files (sizes vary by a few bytes with the build stamp) against a 2,000,000-byte budget (`scripts/check_dist.py`, run by `npm run build`); the main script is 1,340,575 bytes because all 44 lessons (now with their further examples) are bundled. The timings below were measured at release `07841e6` and the perf budgets still pass in every run since. `e2e/perf.spec.ts` measures a local production build in Playwright's Chromium on an Apple M4 Pro, with budgets as regression guards: DOMContentLoaded about 31 ms, first contentful paint about 72 ms (when Chromium reports it), moving between lesson steps 8–16 ms (timed until the destination step's own heading is shown), and Python on a fresh page: 1.1–1.5 s from opening an exercise to its first output, which includes Pyodide's start-up (it loads from the CDN; network conditions were not controlled, so the download may have been cached), of which 0.9–1.4 s is the wait after pressing Run, since the app starts Python in the background when a lesson with code opens; warm runs about 60 ms; main-thread heap about 10 MB. With the CPU slowed four times, page work slows about threefold (DOMContentLoaded about 85 ms, steps 26–48 ms); Python times barely change, so the Python worker probably isn't throttled and those figures don't stand for a slow device. A slow network was measured after this release (G-27) on a cold browser profile, with every request, the Python worker's included, sent through one simulated link: on a 3G-like link (1.6 Mbps, 300 ms) DOMContentLoaded came at 7.4 s, the lesson step's heading at 7.5 s and the first Python output 85 s after opening the page; on a 4G-like link (9 Mbps, 85 ms) at 1.4 s, 1.5 s and 16 s. The simulation counts the 13.9 MB of Pyodide uncompressed; the CDN sends about 5.6 MB compressed (measured with curl), so a real first load should be faster: a rough bandwidth estimate, not a measurement, is about 40 s on the 3G-like link. End-to-end loading with real compression on a slow link remains **UNVERIFIED**. Python's load limit is now 240 s (it was 90 s, which a link below about 0.6 Mbps would have exceeded), and the loading message says a slow connection can take a minute or more. Real mobile hardware and memory used inside the Python worker are **UNVERIFIED**. |
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
| T20 production deploy | DONE | [run 43665292702](https://github.com/Wai-999/python-intelligence/actions/runs/43665292702) |

## BLOCKED, PARTIAL and UNVERIFIED

- **DONE (§5 optional controls, since the last report):** "Try another example" cycles two further worked examples on
  every example step (G-22; the content gate requires them and runs each one). "Show execution trace" now traces the
  learner's own code too: every example and exercise can step through its current code line by line, with names, the
  call stack and output, in the lessons' viewer (G-26; at most 300 steps, values shown without running learner code).
  "Challenge me independently" links every step to its transfer problem. There is no separate "Why?" button: each step's
  header says why the lesson comes where it does, and the tutor note explains failed checks.
- **Deploy history since the last report:** two pushes (G-25 and G-26) failed their gates on CI and deployed nothing,
  because the new header-height guardrail caught the header wrapping on CI's wider Linux fonts; the site kept serving
  the last passing build until the fix in `e05748b`.
- **DONE (interface architecture, G-20 to G-25):** a learning header with Resume, one primary action per screen, the map
  grouped by track, a result summary that leads, a connection status, a recap reflection, a first-visit start, a
  plain-words Review page, "Last saved" in the progress panel, contrast tokens with high-contrast and forced-colours
  support, a two-row phone header with a Menu, and a confidence prompt before a first transfer attempt that feeds the
  learner model's confidence calibration.
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

Rolling back doesn't touch learners' data, which stays in each browser, but whether the older build can use it depends on
the storage schema:

- Since `998e033` (G-2) the IndexedDB database is version 2 and exports are format version 2. Rolling back to any build
  from `998e033` onwards keeps progress usable.
- Rolling back to a build before `998e033` is not safe for returning learners. The browser refuses to open a version 2
  database with older code, so the old build can't read or save progress, and it can't import version 2 exports. Their
  data stays in the browser and works again once a version 2 build is redeployed. Before such a rollback, ask learners to
  export their progress (Progress → Export). This was verified after this release (G-27) with the last version 1 build
  (`ab81baa`) and the current one served in turn on one origin, with one persistent browser profile: after two reloads
  the old build is running (its service worker took over), shows "Progress can't be saved in this browser" (its stated
  reason, "database upgraded in another tab", is that old build's wording and is misleading here) and changes nothing;
  rolled forward again, the saved position and the learner events are intact.
- Check a target's schema with `git show <sha>:src/progress/store.ts | grep DB_VERSION` and
  `git show <sha>:src/progress/types.ts | grep EXPORT_VERSION`.

## Next step with the most value

The owner's decision on G-T, which needs a server and API keys. Of the static-site work, what remains is marked
**UNVERIFIED** above: manual screen-reader testing and performance on real mobile hardware.
