<!-- Written by a Fable 5.1 agent from screenshots of the live interface (2026-11-14); the plan G-20 onwards follows. Screenshot paths refer to a local scratch folder that is not in the repo. -->
# Python Intelligence — Interface Architecture

Scope: the React/Vite static site in `python_intelligence_cli_package` (deployed under `/python-intelligence/`). Judged against the master prompt §1 (Current lesson, Why this lesson, Next recommended lesson and Resume visible at all times), §5 (lesson flow and the optional controls "Why?", "Show execution trace", "Try another example", "Challenge me independently") and §10 (persistent learning header, main learning view, graph states, responsive/keyboard/landmarks/live regions/reduced motion/high contrast/autosave/offline status, WCAG 2.2 AA, no feedback overload, one primary next action).

Evidence: 62 screenshots in `<scratch>/shots/` (`<screen>-<desktop|phone>-<light|dark>.png`, full page) and first-viewport crops in `.../crops/`. Captured from the production build served with `e2e/serve.mjs` on port 4180 (server stopped afterwards). An axe-core pass (WCAG 2.x A/AA + 2.2 AA + best-practice tags) was run on seven screens in both schemes; contrast ratios of every token pair were computed (section 6).

---

## 1. Diagnosis

### What works (keep it)

| Area | Evidence | Notes |
|---|---|---|
| Lesson arc and step labelling | `02-lesson-motivation-desktop-dark.png`, `03b-example-ran-desktop-light.png`, `11-visual-trace-desktop-light.png` | Kind label ("Why it matters · step 1 of 7"), Goal box on the motivation step, analogy, "Common mix-ups" disclosure, citations line, stepper with sr-only text, focus moved to the step heading on every step change (`LessonView.tsx:50`). |
| "Why this lesson" and "Challenge me independently" | `02-*`, `05-transfer-step-desktop-light.png` | Present on every lesson step (`LessonView.tsx:68-74`), built from the graph (`curriculum/standing.ts`). |
| Exercise loop | `04-guided-failed-tutor-phone-light.png`, `crops/b-04b-hints-desktop-light.png` | Textarea editor with keyboard help, "Run checks", per-check ✓/✗ rows with sr text, "Professor's note" labelled OFFLINE GUIDE, suggested-support note, hints one at a time, solution gated behind two failures and a confirm. Drafts autosave (400 ms debounce, IndexedDB). |
| Quiz and placement check | `06b-quiz-submitted-desktop-light.png`, `09b-diagnostic-group-desktop-dark.png` | Per-question explanation, "Not sure" option, stop-here control, clear result copy. |
| Execution visualiser | `11-visual-trace-desktop-light.png` | Current line, call stack, locals table, output, step note in a polite live region. |
| Map state wording | `01-home-desktop-light.png`, `CurriculumMap.tsx:102` | Locked / Ready / In progress / Completed independently / Completed with help / Tested out / ", review due" are words, not colours. |
| Resume | `App.tsx:125` | The saved position is restored on load when the URL has no hash. |
| Automated a11y | axe run (this audit) and `e2e/a11y.spec.ts` | 0 WCAG A/AA violations on home, lesson steps, review, diagnostic, trace, light and dark. Only best-practice findings: `page-has-heading-one` on every lesson step (there is no `h1`), `heading-order` in the trace viewer (`h4` under `h2`). |
| Colour contrast | section 6 | Every text/background token pair is ≥ 5.29:1 (light) and ≥ 5.69:1 (dark); AA passes with margin. |

### What is missing against §1.4 and §10

1. **No persistent learning header.** The top bar is brand · Library · Review · "0/44" bar · Progress (`crops/01-home-desktop-light.png`, `crops/02-lesson-motivation-desktop-dark.png`). None of goal, course, current lesson, confidence label, Resume, or Next recommended task is shown anywhere persistent. On `#/review`, `#/library` and `#/diagnostic` there is no Resume and no Next at all (`crops/v-08-review-desktop-light.png`, `09-diagnostic-intro-phone-light.png`). On a lesson, "Next recommended" appears only on the recap step, and only when the lesson is complete (`LessonView.tsx:165` returns `null` when the recommendation is "continue this lesson").
2. **Progress confidence label is absent.** The only confidence information is the Review table's "0% (medium uncertainty)" per concept (`crops/v-08-review-desktop-light.png`) and "mastery 100%" numbers in map metadata; neither is a label a learner can act on.
3. **No offline / save status.** Nothing in `src/` reads `navigator.onLine`; a failed service-worker registration is only `console.warn`ed (`sw-register.ts:10`); autosave is silent; the Python runtime state is only visible inside the run bar of a cell.
4. **No reflection panel.** §10 asks for one in the main view. The recap has a read-only rubric ("Check your own work", `crops/07-recap-desktop-light.png`); the MesoPanel asks for a written sentence but is event-triggered only. The event schema already accepts `confidence: 1..5` (`learner/model.ts:46`) and computes `confidenceCalibration`, but no UI ever collects it.
5. **§5 controls are incomplete.** "Challenge me independently" exists. "Try another example" exists as uncommitted `Examples.tsx` but no lesson carries a `more` array yet, so the button never renders. "Show execution trace" exists only as a dedicated visual step; there is no control on example or exercise cells. "Why?" exists only as "Why this lesson", never on feedback ("why did this check fail", "why this hint level").
6. **No high-contrast or forced-colors handling.** `styles.css` has `prefers-reduced-motion` (line 165) but no `prefers-contrast: more` or `forced-colors` rules; the state dots (`.dot`), map badges and sticky translucent header depend on background colour in forced-colors mode.

### What is confusing or cluttered

1. **The map is a wall of 44 cards.** Home renders every lesson in one flat list under a single "PYTHON FUNDAMENTALS" heading (`01-home-desktop-light.png` is 5,964 px tall; the phone version `01-home-phone-light.png` is 6,286 px) although the content has five tracks (python-core 20, data 2, statistics 4, ml 15, projects 3; `graph.ts:12`). A new learner sees 1 "Ready" card and 43 locked ones with 🔒 glyphs.
2. **The lesson rail repeats the whole map on every step.** `aside.side` is 6,531 px tall on desktop (measured), so `position: sticky` does nothing; on the phone the full 44-card list is appended after the pager of every step (`02-lesson-motivation-phone-light.png`, `crops/b-02-phone-light-after-lesson.png`), making a one-paragraph step a 6,000 px page.
3. **Two primary buttons on failing steps.** After a failed run, "▶ Run checks" (primary) and "Next →" (primary) are both blue (`04-guided-failed-tutor-phone-light.png` top and bottom). After a failed quiz, "Try again" is secondary while "Next →" is primary (`crops/b-06b-quiz-bottom.png`): the primary action points away from the remedial one.
4. **The recap of an unfinished lesson has no forward action.** It shows a yellow pill listing the steps to pass and a pager with only "← Back" (`crops/07-recap-desktop-light.png`).
5. **Dense lesson header.** Six lines precede the content on every step: eyebrow with "0/3 graded steps passed", Why this lesson, Challenge-me line, stepper, kind line, title, then the Goal box (`crops/02-lesson-motivation-desktop-dark.png`). The Challenge line repeats on all steps including the transfer step's neighbours.
6. **Feedback stack after a failure.** Empty console placeholder ("Output appears here.") + three check rows + a three-paragraph Professor's note + support sentence + hint + two buttons, then a MesoPanel can be added below that (`04b-guided-second-fail-hint-desktop-light.png`). The failing-first summary ("2 of 3 checks failed. First: …") is buried inside the note instead of leading the results.
7. **Phone header wraps to two rows** (105 px sticky, 12 % of a 844 px viewport) with four controls plus "0/44" (`crops/v-01-home-phone-light.png`).
8. **Review page speaks model-ese**: "learning · 0% (medium uncertainty) · —" for concepts touched once (`crops/v-08-review-desktop-light.png`); on the phone the "Next review" column is off-screen (`08-review-phone-dark.png`).
9. **Heading hierarchy**: the lesson title is a muted `<p class="eyebrow">`; the step title is the page's only heading and it is an `h2`; trace viewer sub-headings are `h4` (axe best-practice findings above).

---

## 2. Information architecture

### Page types (hash routes, unchanged URLs)

| Route | Page type | Primary job | Primary action (exactly one) |
|---|---|---|---|
| `#/` | **Home / course map** | Orient: where am I, what next | First visit (no events, no position): "Find your starting point" (placement). Returning: "Resume: <lesson> · step n". Position complete: "Next lesson: <title>". |
| `#/diagnostic` | **Placement check** | 5 groups, stop at first unknown | Start → Check answers → Next group / See your starting point → "Start: <lesson>" |
| `#/lesson/:id/:step` | **Lesson player** | Teaching cadence per step | Depends on step state (section 2.4) |
| `#/review` | **Review** | Due retrieval first, evidence second | "Check answer" / "Next review"; when nothing is due: "Resume: <lesson>" |
| `#/library` | **Library** | Sources | none in main; the header's Resume is the page's primary |
| (dialog) | **Progress** (export/import/reset) | Data ownership | "Export progress" inside the dialog only (header primary hidden while open) |

### 2.1 The persistent learning header (`LearningHeader`, new)

One component owns the §10 header. It is rendered by `App.tsx` above `.layout` on every route, replacing the current `header.top`. It is a `<header>` containing `<nav aria-label="Primary">` and a `<p class="now" aria-live="off">` status strip.

**Desktop (≥ 960 px), one row, left → right:**

1. Brand mark + "Python Intelligence" (link to `#/`).
2. **Now strip** (text, not buttons), in this order:  
   `Goal: <track end>` · `Course: <track label>` · `Lesson: <current title> (k of n in track)` · `<confidence label>`  
   - *Goal* = the end node of the learner's current track: "Python core → write and test real programs" (python-core), "Data → explore a table" (data), "Statistics → reason with simulation" (statistics), "ML → the capstone project" (ml), "Projects → ship a small program" (projects). Static strings keyed by track in `src/curriculum/tracks.ts` (new).  
   - *Current lesson* = the saved position (`store.load().position`), else the recommendation.  
   - *Confidence label* (section 4, `confidenceLabel()`): "Not started" · "Getting started" · "Practising" · "Completed with help" · "Completed independently" · "Durable" — plus " (early estimate)" when the learner model's `uncertainty` is `high` for the lesson's concepts.
3. **Actions**: `Resume ▶` (primary **only** when the route is not already the saved position), `Next: <title> →` (plain link, from `recommendNext`; hidden when it equals the current lesson), `Review` (with the due badge, unchanged markup so `getByRole("link", { name: /^Review/ })` keeps working), `Library`, `Progress` (button, `aria-expanded`, unchanged name so 20 e2e references keep working). The `0/44` figure moves into the Progress button's accessible text and into the Now strip as "k/44 lessons done" on home only; keep an element with class `overall` containing "n/44" (e2e `exercise-state.spec.ts:292,304` reads `.overall`).

**Phone (< 600 px), max 2 rows, ≤ 96 px sticky:**

Row 1 (48 px): brand mark `py` · Now strip truncated to `<current lesson title>` with `text-overflow: ellipsis` · `Menu` button (opens a `<dialog>`-less disclosure listing Review (badge), Library, Progress, Resume/Next text links).  
Row 2 (40 px): the single primary action for the route when it is a header action (Resume / Next lesson), or the confidence label + "k of n" when the page body owns the primary. Nothing else.

**Tablet (600–959 px):** desktop row 1 without Goal (Course · Lesson · Confidence) and with the same actions.

### 2.2 Navigation

- **Course map** (home): grouped by track in `graph` order, each track a `<section aria-labelledby>` with a count ("Python core · 3 of 20 done"). Inside a track, lessons that are *ready, in progress, due or completed* are listed; locked lessons collapse behind a `<details>` "and 17 locked lessons" (open by default when the track has fewer than 4 visible cards). Tracks after the current one start collapsed with a one-line summary. This removes the wall without hiding the endpoint (§1.3): a "Path to the end" line under each track lists the next 3 unlock steps as text.
- **Lesson rail** (desktop aside): shows only the current track's lessons in compact form with the current one marked, plus a "Full course map" link. Heights become ~20 cards (python-core) at most; the rail is `max-height: calc(100vh - header)` with `overflow:auto` so sticky works.
- **Phone**: the rail becomes a `<details class="rail">` "Course map (<track>)" placed after the pager, closed by default; no 44-card list.
- **Stepper** (unchanged semantics): `nav aria-label="Lesson steps"`; each dot gets `aria-label` text already present. Add `scroll-margin-top: 80px` to focus targets.
- **Skip link** unchanged; add `#rail` as a second skip target on lesson pages ("Skip to course map").

### 2.3 How "one primary next action" is guaranteed

Implementation rule, not convention: a single pure function `primaryAction(route, lessonState, headerState)` in `src/ui/primary.ts` (new) returns `{ owner: "header" | "main", kind, label, href|onClick }`. The header renders its Resume/Next as `.btn.primary` only when `owner === "header"`; every view receives `primary` as a prop and renders its own primary button only when `owner === "main"`. The pager's "Next →" is `.btn.primary` only when `primaryAction` says so; otherwise it is `.btn` ("Next →" stays, demoted, or "Skip for now →" on an unpassed exercise).

Acceptance (e2e `primary.spec.ts`, new): on every state in the matrix below, `page.locator('.btn.primary:visible')` has count 1 and its text matches the expected label.

### 2.4 Primary action matrix

| Screen state | Primary (owner) | Secondary |
|---|---|---|
| Home, first visit | "Find your starting point" (main) | "Start from the first lesson" |
| Home, returning, position in progress | "Resume: <lesson> · step n" (main) | track cards |
| Home, position lesson complete | "Next lesson: <title>" (main) | — |
| Prose/visual/example step | "Next →" (main pager) | Back, run cell (secondary styling), "Try another example" |
| Exercise, not yet passed | "▶ Run checks" (main) | "Skip for now →" ghost in pager, hints |
| Exercise, passed this visit or earlier | "Next →" (main pager) | "▶ Run checks" becomes `.btn` |
| Quiz, before submit | "Check answers" | — |
| Quiz, failed | "Try again" | "Next →" ghost |
| Quiz, passed | "Next →" | — |
| Recap, lesson incomplete | "Finish: <first unpassed graded step> →" | Back |
| Recap, lesson complete | "Next lesson: <title> →" (Recommend) | "Review first: <title>" when remediation |
| Review with due item | "Check answer" / "Next review" | — |
| Review, nothing due | "Resume: <lesson>" (header) | — |
| Library, Diagnostic intro | header Resume / "Start the placement check" | — |
| Progress dialog open | "Export progress" (dialog) | header primary hidden |
| Meso panel showing | the panel's own button ("Check my prediction" / "I've compared them") becomes the only primary; Run checks demoted until the panel is answered or postponed | "Not now" |

---

## 3. Layout system

### Grid and breakpoints

- Container `max-width: 1180px`, side gutter `--gap: clamp(16px, 2.5vw, 24px)` (raise the floor from 12 to 16 px for phones).
- Breakpoints: **phone < 600**, **tablet 600–959**, **desktop ≥ 960**, **wide ≥ 1280** (only affects prose measure and editor height, never adds columns).
- Lesson page grid: desktop `grid-template-columns: 280px minmax(0, 1fr)` (rail, main); tablet and phone single column, rail after main inside `<details>`.
- Home grid: single column of track sections; inside a track, cards in `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))` on desktop, one column on phone.
- Sticky header heights: desktop 56 px, phone ≤ 96 px; `--header-h` custom property drives `top:` of the sticky rail and `scroll-margin-top` of focus targets.

### Spacing and type

Tokens in `:root` (styles.css), 4-px base: `--s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px`.  
Type scale (px / line-height): `--t-xs 13/1.4` (meta), `--t-sm 14/1.45` (labels, badges), `--t-base 16/1.6` (UI), `--t-prose 17/1.65` (lesson text, max 72ch), `--t-h3 20/1.3`, `--t-h2 24/1.25` (step title; `clamp(22px, 3vw, 28px)`), `--t-h1 30/1.2` (page titles), `--t-hero clamp(28px, 5vw, 40px)`. Mono: `14.5/1.55` editor, `14/1.55` code blocks. Touch targets ≥ 40 px (already), 44 px on phone for the run bar.

### Lesson view arrangement (top → bottom), and the overload rules

```
[LearningHeader]  (sticky)
┌ rail (desktop) ┬ main ──────────────────────────────────────────────┐
│ track lessons  │ StepHeader: h1 lesson title (visually 14px eyebrow) │
│ current marked │   · "Why this lesson" (one line, <details> on phone)│
│ Full map link  │   · Stepper                                         │
│                │ kind · step n of N                                  │
│                │ h2 step title                                       │
│                │ Goal box (motivation step only)                     │
│                │ Prose (≤72ch) · analogy · mix-ups · sources         │
│                │ ── Work zone (exercise/example) ──────────────────  │
│                │ Editor (textarea)                                   │
│                │ RunBar: [Run checks] [Reset] status · ⓘ Why?        │
│                │ ResultSummary line (role=status): "2 of 3 checks    │
│                │   failed · first: area exists"                      │
│                │ Checks list (failures first)                        │
│                │ Console (collapsed to a 1-line bar when empty)      │
│                │ ── Guidance zone: ONE expanded card ─────────────── │
│                │ Professor's note  ⟷  Meso panel (the newer one      │
│                │   expands; the other collapses to a summary line)   │
│                │ Help: <details> "Need a nudge? (suggested: 2 hints)"│
│                │   hints one at a time · solution gate               │
│                │ ── Reflection (summary step) / confidence prompt ── │
│                │ Pager: [← Back]           [primary or demoted Next] │
│                │ Challenge-me link lives here (once, in the pager    │
│                │   row), not in the header                           │
└────────────────┴─────────────────────────────────────────────────────┘
```

Overload rules enforced in `Exercise.tsx`:
1. At most **one** expanded guidance card at a time (`TutorNote` or `MesoPanel`). When a MesoPanel appears, the TutorNote collapses to "Professor's note: 2 of 3 checks failed · Show" (a `<details>`). When the meso panel is answered/postponed it collapses to one line and the note re-expands only if the next run fails.
2. The Console renders its full box only when there is output or an error; otherwise a 32 px bar "No output yet" (keeps `role="log"` so `.console pre` selectors in e2e still work once output exists).
3. The support sentence ("Suggested support: up to 2 hints…") moves into the `<details>` summary as "(suggested: 2)". The hint buttons keep their accessible names (`/Show a hint/` is used by e2e).
4. The Goal box renders only on the motivation step (already), the analogy only on intuition, the mix-ups only on formal/example (already).
5. "Why this lesson" stays on every step (§1.4) but as a single line; on phone it is a `<details>` whose summary is "Why this lesson".

---

## 4. Component inventory

Each entry: responsibility · states · accessibility contract. "Keep" = exists and keeps its DOM contract for the test suite.

**LearningHeader** (new, `src/components/LearningHeader.tsx`)  
Responsibility: §10 header (goal, course, current lesson, confidence label, Resume, Next, Review, Library, Progress, offline/save status slot).  
States: `loading` (progress not read: shows brand + "Loading your progress…" in the strip, actions disabled), `first-visit` (no position: Now strip says "Start: <first lesson>"), `at-position` (Resume hidden, strip says "You're here"), `away` (Resume primary), `offline` (StatusBadge visible), `store-error` (strip shows "Not saving in this browser" with the existing alert below).  
A11y: `<header>` + `<nav aria-label="Primary">`; Now strip is a `<p>` with visually-hidden labels ("Current lesson:"); the due badge keeps `aria-label="n due"`; Progress keeps `aria-expanded`; focus order brand → strip links → actions; phone Menu button `aria-expanded` + `aria-controls`, Escape closes and returns focus. Header never uses `aria-live` (the Announcer does).

**StatusBadge / Announcer** (new, `src/components/Status.tsx`)  
Responsibility: offline/online, service-worker readiness ("Works offline" once `navigator.serviceWorker.controller` exists), Python runtime state, autosave ("Saved" / "Saving…" / "Can't save").  
States: `online-ready`, `online-no-sw`, `offline-ready` (all cached: "Offline · lessons and Python available"), `offline-partial` ("Offline · Python not downloaded yet"), `saving`, `saved`, `save-failed`.  
A11y: one `aria-live="polite"` region (`#announcer`, visually hidden) shared by the app for transient messages (checks summary, draft saved, offline change); the visible badge itself has `role="status"` only for offline transitions (one message per change). Uses `online`/`offline` events and `navigator.onLine`; no network calls.

**CurriculumMap** (keep, refactor)  
Responsibility: course graph by track with states.  
States per item: `locked`, `open` (Ready), `started`, `done` (+completion independent/assisted/unknown), `tested`, `due`, `current`; per track: `collapsed`/`expanded`; whole map: `empty` (graph error - never in practice), `compact` (rail).  
A11y: `<nav aria-label="Curriculum">` → `<section aria-labelledby="track-x">` → `<ol>`; locked items are `<span aria-disabled="true">` (keep), state text stays in the item (`.map-meta`), badges have `aria-hidden` glyph + text; `<details>` for collapsed groups with summary text including counts. Keep classes `.map-item.done|tested|due|locked|started|open|current` and `.map-meta` (e2e).

**LessonView / StepHeader / Stepper** (keep, restructure)  
States: `unlocked`/`look-ahead` (warn pill), step kinds, `complete`.  
A11y: lesson title becomes `<h1 class="eyebrow-h1">` (fixes `page-has-heading-one`), step title stays `<h2 id="step-title" tabIndex=-1>` focused on change; `scroll-margin-top: var(--header-h)`; pager is `<nav aria-label="Step navigation">`; the "Challenge me independently →" link keeps its exact name.

**Prose** (keep). **Sources/FurtherReading** (keep).

**Examples** (WIP → finish)  
Responsibility: example cell plus "Try another example" cycling `step.more`.  
States: `single` (no `more`: button hidden), `n-of-m`, `moved` (heading focused).  
A11y: on change, focus the "Another example: …" `h3`, and announce "Example 2 of 3" via the Announcer; the button's name alternates "Try another example" / "Back to the first example"; the cell's Run button keeps the exact name "▶ Run". Add `aria-controls` to the example container.

**CodeCell / Editor / RunBar / Console** (keep)  
States: Editor `idle|focused|dirty`; RunBar `idle|loading|loading-packages|ready|running|error` (from `usePythonStatus`), plus `offline-unavailable` (status `error` while offline: message "Python isn't downloaded yet; reconnect once to use it offline"); Console `empty|streaming|done|error|infrastructure-error`.  
A11y: textarea with visible label on phone ("Your solution"), help text via `aria-describedby`; Run button `aria-busy`; status `role="status"`; Console `role="log" aria-live="polite"`; add "Show execution trace" as a `.btn ghost` in the RunBar when the lesson has a visual step (links to it) — later a real trace (change 9).

**Exercise** (keep, reorganise)  
States: `fresh`, `running`, `failed(n)`, `passed`, `passed-earlier`, `infrastructure-error`, `with-meso`, `solution-shown`, `confidence-pending` (before the first run of a transfer/challenge: a 3-button "How sure are you?" prompt that writes `confidence` 1/3/5 onto the attempt events; skippable).  
A11y: `<section aria-label="Guided exercise|Challenge|Transfer problem">` (e2e uses "Transfer problem"); ResultSummary `role="status"` is the only live announcement per run; checks `<ul aria-label="Check results">` with sr "passed/failed"; the TutorNote stays `<aside aria-label="Professor's note">` (`getByRole("complementary", …)`); hints `<details>` summary button; solution confirm is a focus-managed inline group (focus "Show it anyway" on open).

**TutorNote** (keep) — add `collapsed` state (summary line) and a "Why?" disclosure: the diagnosis is the "why", so the "Why?" control opens the `question`+`action` paragraphs (default: expanded on the first failure, collapsed on later ones).

**MesoPanel** (keep) — states `shown|answered|postponed`; heading focus on mount (already); when shown it becomes the primary owner (section 2.4); region label unchanged (`section.meso`, heading "Let's step back for a moment").

**Hints / SolutionGate** (extract from Exercise) — states `none|n shown|all shown|solution offered|confirming|solution shown`; button names preserved.

**Quiz** (keep) — states `answering|submitted-pass|submitted-fail|passed-earlier`; after fail "Try again" becomes `.btn.primary` and is focused; result `role="status"` (already).

**TraceViewer** (keep) — headings `h4` → `h3`; add keyboard: ←/→ step when focus is inside the viewer; `aria-current="step"` on the active line (already); announce only the note (already).

**ReflectionPanel** (new, summary step)  
Responsibility: §10 reflection and §5 "reflection → new application". One textarea "In one sentence: what does this lesson let you do now?" saved through the existing `onDraft(stepId = summary step id)`, and three "How confident are you about the transfer problem?" buttons.  
States: `empty|saved|disabled(no store)`; never blocks progression.  
A11y: `<section aria-labelledby>`; textarea with label; "Saved" via Announcer.

**ReviewView** (keep, re-layout) — states `due(n)|answering|answered|empty|unreviewable-list`; plain-language status map (`new → "not started"`, `learning → "practising"`, `complete → "learned, reviews pending"`, `mastered → "durable"`), evidence table in `<details>` "Evidence per concept" (open when a row is focused via hash). Keep the table and row headers (`getByRole("row", { name: /^names/ })`).

**DiagnosticView** (keep) — already has intro/run/done; add a progress stepper "group 1 of 5" as a list with `aria-current`; keep button names.

**ProgressPanel** (keep) — add "Last saved <time>" line and an "Everything is saved in this browser" status; dialog roles and focus return unchanged.

**Library** (keep).

Global: a single `Announcer` live region; every other `role="status"` remains for in-place results only (checks summary, quiz score, review result), none in the header.

---

## 5. Key flows

**A. First visit → placement → first lesson**  
1. `#/` with no events and no position: hero + primary "Find your starting point (about 5 minutes)" + secondary "Start from the first lesson"; map shows track 1 expanded with lesson 1 Ready, "19 locked" collapsed; other tracks collapsed with their goal line.  
2. Header Now strip: "Course: Python core · Start: Values, names and expressions · Not started". Resume hidden (nothing to resume).  
3. `#/diagnostic` unchanged flow; on "done", primary "Start: <lesson> →" (unchanged) and the header strip updates to the recommendation.  
4. First lesson step 0: header "Lesson: Values… (1 of 20) · Getting started"; primary = pager Next. The Python warm-up starts (existing). Status badge shows "Downloading Python… (10 MB, once)" then "Works offline" when the SW controls the page and the runtime cache has the five pinned files.

**B. Working an exercise: fail → hint → pass**  
1. Exercise step: primary "▶ Run checks"; pager Next is a ghost "Skip for now →". Transfer/challenge steps show the confidence prompt once (skippable; selecting writes `confidence` on the next attempt's events).  
2. Run fails: ResultSummary "2 of 3 checks failed · first: area exists" is announced once; failures listed first; Professor's note expanded; "Need a nudge? (suggested: 2 hints, 3 available)" closed. Focus stays in the editor (no focus jumps on results).  
3. Learner opens a hint: the hint is appended inside the details; `onAssist` unchanged; the summary updates to "1 hint shown".  
4. Second fail: note collapses to its summary line if a MesoPanel triggers (meso becomes the primary owner); otherwise the note updates in place. Solution gate appears after `SOLUTION_AFTER` (unchanged).  
5. Pass: ResultSummary "All 3 checks pass" + the 🎉 pill (unchanged text), Run checks demotes to `.btn`, pager "Next →" becomes primary and receives focus (new: focus moves to the primary so keyboard users continue in one key press). Map card and header confidence update ("Practising" → "Completed with help/independently" at lesson completion).

**C. The transfer challenge**  
Entry points: the stepper, the "Challenge me independently →" link (moved to the pager row), and the MesoPanel's transfer target. The step is labelled "Transfer · independent check"; hints are inside a closed details whose summary says "Hints are hidden for this one; open only if stuck"; suggested support text is suppressed when `offered` is 0. On pass without help the header label shows "Completed independently" at lesson completion and the map badge becomes ✓✓.

**D. A due review**  
Header Review link shows the badge (unchanged); the Now strip appends "· 2 reviews due" on home. `#/review`: recall prompt → question → answer → "Next review"/"Done"; when the queue empties, the primary becomes the header's "Resume: <lesson>" and the page shows "Nothing is due. Resume where you left off" with the same link. The "Also due, but without a review question yet" list stays as a muted paragraph. The map's ", review due" text and `.map-item.due` class remain.

**E. Returning after closing the browser**  
1. Load with no hash: `location.replace` to the saved position (unchanged, `App.tsx:125`).  
2. Header: "Lesson: <title> · step n of N · <label>"; Resume hidden because we are at the position; Status: "Saved · Works offline" when applicable.  
3. The exercise restores the draft, hints shown and failures (unchanged); the ResultSummary says "Draft restored from your last visit" (no live announcement).  
4. If reading storage failed, the existing alert + "Try loading it again" stays, and the header strip reads "Progress not loaded"; all primaries are disabled (`inert` already applies).  
5. If another tab replaced progress, `replacing` makes the page inert (existing); the status badge shows "Updating from another tab…".

---

## 6. Visual design

### Tokens (light / dark), contrast verified

Current palette is kept (all pairs pass AA; measured ratios below); additions marked *new*.

| Token | Light | Dark | Checked pair (light / dark) |
|---|---|---|---|
| `--bg` | `#f7f8fb` | `#0d1220` | text on bg 15.3 / 15.8 |
| `--surface` | `#ffffff` | `#141b2d` | text on surface 16.3 / 14.5 |
| `--surface-2` | `#eef1f7` | `#1b2438` | muted on surface-2 5.6 / 6.9 |
| `--text` | `#172033` | `#e7ecf5` | |
| `--muted` | `#556074` | `#a2adc2` | on bg 6.0 / 8.3; on accent-soft 5.3 / 6.3 |
| `--accent` | `#2456c4` | `#7aa2ff` | on surface 6.6 / 6.9; on accent-soft 5.5 / 5.7 |
| `--accent-ink` | `#ffffff` | `#0b1020` | on accent 6.6 / 7.6 |
| `--ok` / `--ok-soft` | `#17713e` / `#e2f4e9` | `#63d394` / `#143222` | 5.3 / 7.5 |
| `--bad` / `--bad-soft` | `#b3261e` / `#fbe7e5` | `#ff8a80` / `#3a1714` | 5.5 / 7.0 |
| `--warn` / `--warn-soft` | `#7a5300` / `#fff3d6` | `#f5c35b` / `#3a2c0b` | 6.2 / 8.3 |
| `--code-bg` / `--code-ink` | `#0f172a` / `#e2e8f0` | `#0a0f1c` / `#e2e8f0` | 14.5 / 15.5 |
| `--border` | `#d5dbe6` | `#2c3852` | non-text; 1.4 / 1.5 (see high-contrast below) |
| `--border-strong` *new* | `#8a94a8` (3.1 on surface) | `#5d6b8a` (3.2) | used for inputs, radio/checkbox borders and card edges that convey state (WCAG 1.4.11 ≥ 3:1) |
| `--focus` *new* | `#2456c4` | `#9db8ff` | 3 px outline + 2 px offset (already), plus a 1 px `--surface` inner halo so it is visible on `--code-bg` |
| `--header-h` *new* | `56px` / phone `96px` | | drives sticky offsets |

Trace active line: replace hard-coded `#facc15` inset with `--hl-edge` (`#b45309` light / `#facc15` dark).

**High contrast / forced colors** (new blocks in styles.css):  
`@media (prefers-contrast: more)`: `--border: var(--border-strong)`, header background opaque (no `color-mix` transparency, no blur), `--muted` → `#3b4458` / `#c3cbdc`.  
`@media (forced-colors: active)`: `.dot`, `.map-badge`, `.checks li`, `.choice.right/.wrong`, `.btn.primary` get `border: 1px solid` (CanvasText/ButtonText) and `forced-color-adjust: none` is **not** used; state is already in text, so only outlines need to survive.

### Map state badges (text + icon, never colour alone)

| State | Glyph (aria-hidden) | Visible text | Style |
|---|---|---|---|
| locked | 🔒 | "Locked · needs X" | `--surface-2`, dashed `--border-strong` |
| ready | number | "Ready" | `--surface`, accent number |
| in-progress | number | "In progress · step n of N" | accent-soft badge, solid accent left border |
| completed-assisted | ✓ | "Completed with help" | ok-soft badge, ok outline |
| completed-independent | ✓✓ | "Completed independently" | ok badge filled, ok text |
| review-due | ↻ (appended) | ", review due" | warn left border 4 px (replaces the current accent border so "due" and "current" differ) |
| tested-out | ↷ | "Tested out" | dashed badge (existing) |
| current | — | `aria-current="page"` | 2 px accent ring (existing) |

### Motion

Durations: 120 ms (hover/focus), 180 ms (disclosure open, badge change), 240 ms (panel appear). Easing `cubic-bezier(.2,.7,.2,1)`. Only `opacity`/`transform`/`max-height` are animated; no autoplay. The existing global `prefers-reduced-motion` kill-switch stays; additionally, the step-change scroll uses `behavior: "auto"` and the trace viewer's line highlight never animates.

---

## 7. Prioritized change plan

Effort: S ≤ half a day, M 1–2 days, L 3+ days. All changes are static-site only (no server, no new network calls). Preserve every selector listed in section 4 "keep" notes; run `npm test`, `npm run build`, `npx playwright test` after each item.

**1. Persistent learning header (§1.4, §10) — M**  
Files: new `src/components/LearningHeader.tsx`, new `src/curriculum/tracks.ts` (TRACK_LABEL, TRACK_GOAL; move `TRACKS` from `graph.ts:12` there and re-export), new `src/ui/confidence.ts` (`confidenceLabel(lesson, progress, model, events)` using `completionOf` and `ConceptState.uncertainty/durable`), `src/App.tsx` (replace `header.top` lines 269-282; pass `position` from `store.load()` into state so the header knows the saved position), `src/styles.css` (`.top` → `.lh`, keep `.overall` and `.badge`).  
Why: nothing persistent shows current lesson, course, confidence, Resume or Next today.  
Acceptance: new `e2e/header.spec.ts`: on `#/review`, `#/library`, `#/diagnostic` and a lesson step, `getByRole("navigation", { name: "Primary" })` contains "Lesson:" text, a Resume link when away from the saved position and none when at it; unit test for `confidenceLabel` covering the six labels; `exercise-state.spec.ts` `.overall` assertions still pass; axe clean.

**2. One primary action per screen — M**  
Files: new `src/ui/primary.ts`; `src/components/LessonView.tsx` (pager: primary only when `primary.owner === "main" && kind === "next"`; `NextUp` renders "Finish: <step> →" primary when incomplete, lines 143-160), `src/components/Exercise.tsx` (RunBar `primary` prop; `runLabel` unchanged), `src/components/CodeCell.tsx` (RunBar accepts `variant`), `src/components/Quiz.tsx` (Try again primary on fail, focus it), `src/components/MesoPanel.tsx` (reports `active` so Exercise demotes Run checks), `src/components/ReviewView.tsx` (empty state primary = Resume link).  
Why: failing steps show two blue buttons; the unfinished recap has none.  
Acceptance: new `e2e/primary.spec.ts` iterating the matrix in 2.4: `expect(page.locator(".btn.primary:visible")).toHaveCount(1)` and label check; `Exercise.test.tsx` gains "Run checks is primary until passed, then Next".

**3. Course map grouped by track; compact rail — M**  
Files: `src/components/CurriculumMap.tsx` (group `graph.order` by `track`, `<section>` per track, `<details>` for locked and for non-current tracks, `compact` mode filters to the current track and adds "Full course map"), `src/App.tsx:292` (pass `currentTrack`), `src/styles.css` (`.track`, `.rail` `max-height: calc(100vh - var(--header-h) - 24px); overflow:auto`, phone `<details class="rail">` after `.pager`), `e2e/smoke.spec.ts`/`learner.spec.ts` if they count `.map-item` (they use `.map-item.done/.tested/.due`, which keep working; add `details` opening where a locked item must be visible).  
Why: 44 flat cards, 6,500 px rail, phone page 6,000 px per step; perf budget "slowest step navigation < 1500 ms" benefits from ~20 fewer cards per render.  
Acceptance: home desktop full-page height < 2,600 px with default progress (Playwright `page.evaluate(() => document.documentElement.scrollHeight)`); lesson phone page height < 3,000 px on a prose step; `.map-item` count visible on home without opening details = ready+started+done+due+tested lessons; axe clean; `perf.spec.ts` passes.

**4. Feedback stack discipline in the exercise — M**  
Files: `src/components/Exercise.tsx` (ResultSummary line before checks; failures sorted first; hints/solution into `<details class="help">` with summary "Need a nudge? (suggested: n)"; one-expanded-card rule between `TutorNote` and `meso`; focus the pager primary on pass), `src/components/TutorNote.tsx` (`collapsed` prop → `<details>` with the diagnosis as summary; "Why?" disclosure for question/action), `src/components/CodeCell.tsx` (Console compact when empty: render the `role="log"` container always, the box styling only with content), `src/styles.css`.  
Why: §10 "avoid overwhelming users with feedback panels"; the failing-first summary is currently inside the note.  
Acceptance: `a11y.spec.ts` "failed checks + tutor note" still finds `complementary "Professor's note"` and `.checks li.fail`; new assertion: after two failures with a meso panel, at most one of `aside.tutor:not([data-collapsed])`, `section.meso` is expanded; `getByRole("button", { name: /Show a hint/ })` still works; unit test for failures-first ordering.

**5. Offline, save and runtime status (§10 "clear offline status", "autosave") — M**  
Files: new `src/components/Status.tsx` (StatusBadge + Announcer), `src/sw-register.ts` (export `swState(): Promise<"controlled"|"unsupported"|"failed">` and a `runtimeCached()` check against `caches.open("pi-pyodide-0.27.8")` keys, same list as `e2e/offline.spec.ts`), `src/App.tsx` (mount Announcer once; pass `online` to LearningHeader; `onDraft` reports saved/failed to the badge), `src/components/Exercise.tsx` (call `onSaved` after `onDraft` resolves — change `onDraft` to return the store promise), `src/styles.css`.  
Why: no offline indicator exists; a failed SW registration is invisible; autosave is silent.  
Acceptance: `offline.spec.ts` addition: after `context.setOffline(true)` the badge text contains "Offline"; after one online run it contains "Works offline"; when `putDraft` rejects (mock via `page.addInitScript` making `indexedDB.open` fail) the badge reads "Can't save" and the existing alert remains; axe clean; only one `aria-live` region besides `role="log"` consoles.

**6. Heading structure and landmarks — S**  
Files: `src/components/LessonView.tsx` (lesson title → `<h1 class="lesson-title">`, keep `#step-title` as `h2`), `src/components/TraceViewer.tsx` (`h4` → `h3`), `src/App.tsx` (`<nav aria-label="Primary">` inside the header; the lesson `aside` gets `aria-label="Course map"`), `src/styles.css` (`.lesson-title` styled like the eyebrow; `scroll-margin-top: var(--header-h)` on `[tabindex="-1"]` headings).  
Why: axe best-practice `page-has-heading-one` on every lesson step and `heading-order` in the visualiser; screen-reader users land on a page with no `h1`.  
Acceptance: `a11y.spec.ts` `TAGS` gains `"wcag22aa"` and `"best-practice"` with zero violations on the scanned states; `getByRole("heading", { level: 1 })` on a lesson step equals the lesson title; existing `getByRole("heading", { name: "<step title>" })` assertions unchanged.

**7. Recap: finish action, reflection and confidence (§10 reflection panel; §5 prediction) — M**  
Files: `src/components/LessonView.tsx` (`NextUp`: primary "Finish: <first unpassed graded step> →"; mount `ReflectionPanel`), new `src/components/ReflectionPanel.tsx` (textarea saved via `onDraft(summaryStep.id, text)`; confidence buttons stored in component state and passed to the next exercise attempt through a new optional `confidence` on `AttemptDetail` → `exerciseEvents(..., { confidence })`), `src/learner/record.ts` (thread `confidence` into events; schema already validates 1..5), `src/components/Exercise.tsx` (3-button prompt on transfer/challenge before the first run; skippable), `src/progress/drafts.ts` (no change: drafts are keyed by step id).  
Why: the recap of an unfinished lesson dead-ends; the model computes `confidenceCalibration` but nothing feeds it.  
Acceptance: `App.test.tsx`: recap of an incomplete lesson renders exactly one primary whose text starts with "Finish:"; `record.test.ts`: `confidence` propagates to every event of the attempt; e2e: reflection text survives reload (`textarea` value restored from drafts); the prompt never blocks "Run checks".

**8. "Try another example" (finish the WIP) — S code + M content**  
Files: `src/components/Examples.tsx` (announce "Example n of m" via Announcer; `aria-controls`; keep button names), `src/components/LessonView.tsx:120` (already wired), `src/content/types.ts` (`more` already typed), `scripts/validate_content.py` (already validates `expected_output` of `more`: confirm in the uncommitted diff), content: add 1–2 `more` examples to the example step of the first ten python-core lessons (`content/lessons/py-*.json`), each with `expected_output` so the content gate executes them.  
Why: §5 control exists in code but is unreachable without content.  
Acceptance: `npm run validate:content` passes with the new examples; new e2e: on `#/lesson/py-values-names/2` the button "Try another example" is visible, clicking it focuses the "Another example:" heading and "▶ Run" produces the second `expected_output`; `a11y.spec` "example with output" still passes.

**9. "Show execution trace" control (§5) — S now, L later**  
Now: `src/components/CodeCell.tsx` RunBar gets an optional `traceHref`; `LessonView.tsx` passes the lesson's visual step index for example and exercise steps ("Show execution trace" links to "See it run").  
Later (L, separate PR): `src/py/harness.py` gains a `trace=True` mode using `sys.settrace` to capture ≤ 300 `{line, locals(repr ≤ 60 chars), stack, output}` frames into the same `TraceFrame` shape; `src/py/protocol.ts` + `worker.ts` + `runner.ts` add `trace(code)`; `Exercise`/`CodeCell` show a "Show execution trace" toggle that renders `TraceViewer` under the console for the learner's own code.  
Why: tracing is the one §5 control with no path from an exercise today.  
Acceptance (now): link present on example/exercise steps of lessons with a visual step, absent on `py-values-names` (no visual step). (Later): unit test for the harness on a 3-line program; e2e: trace of the learner's draft shows the right final locals; runs stay within `perf.spec` budgets.

**10. Phone layout compaction — S**  
Files: `src/styles.css` (header ≤ 96 px, `--gap` floor 16 px, `.rail` details after pager, run bar buttons 44 px, `.editor-help` wraps to two lines without overflow), `src/components/LearningHeader.tsx` (Menu disclosure), `src/App.tsx` (rail placement).  
Why: the current header wraps to 105 px and the map follows every step (`04-guided-failed-tutor-phone-light.png`, `b-02-phone-light-after-lesson.png`).  
Acceptance: Playwright mobile project: `header` bounding height ≤ 96 px on home and lesson; no horizontal scroll (`document.documentElement.scrollWidth === 390`); `smoke.spec` mobile passes.

**11. Review page re-layout — S**  
Files: `src/components/ReviewView.tsx` (due block first, friendlier `STATUS` strings, table inside `<details open={due.length === 0}>`, "Resume" link in the empty state), `src/styles.css` (`.concepts` sticky first column on phone).  
Why: model-ese ("0% (medium uncertainty)") and the hidden "Next review" column on phones.  
Acceptance: `review.spec.ts` unchanged assertions pass (`getByRole("row", { name: /^names/ })`, "Check answer", "Next review"); phone screenshot shows the Concept column at all scroll positions.

**12. Tokens, high contrast, forced colors, focus halo, motion — S**  
Files: `src/styles.css` only (section 6 tokens; `prefers-contrast: more` and `forced-colors` blocks; `--hl-edge`; `.map-item.due` warn border; focus inner halo on dark code backgrounds; `scroll-margin-top`).  
Why: 1.4.11 non-text contrast for inputs/borders (1.4:1 today), no HC/forced-colors handling.  
Acceptance: `a11y.spec` runs an extra scan with `page.emulateMedia({ forcedColors: "active" })` and `({ contrast: "more" })` (Playwright supports both) with zero violations; a unit test in `src/styles.test.ts` (new, jsdom reading the CSS text) asserts the contrast of `--border-strong` on `--surface` ≥ 3:1 for both schemes using the same formula as this audit.

**13. First-visit home and placement nudges — S**  
Files: `src/App.tsx` home section (branch on `events.length === 0 && !position`: primary "Find your starting point", secondary "Start from the first lesson"; returning learners get "Resume: …"), `src/styles.css`.  
Why: today the placement check is a sentence link; the recommendation box is the same for a first and a hundredth visit.  
Acceptance: `diagnostic.spec.ts` still finds "Take the placement check" (keep the link text inside the hero) and `.recommend` keeps its button; new assertion: with an empty store the one `.btn.primary` on home is "Find your starting point".

**14. Progress panel polish — S**  
Files: `src/components/ProgressPanel.tsx` ("Last saved <time>" from the latest `updatedAt` in `exportAll()`; sentence "Everything is saved in this browser"), header Menu placement.  
Acceptance: existing dialog/focus tests pass (`a11y.spec`, `exercise-state.spec`); the time line updates after a draft change.

**15. Guardrails — S**  
Files: `e2e/primary.spec.ts` (from item 2), `e2e/header.spec.ts` (item 1), `e2e/layout.spec.ts` (heights/widths from items 3 and 10), `playwright.config.ts` (add `{ name: "mobile" }` testMatch for the new layout spec).  
Why: keeps the architecture from regressing as content grows past 44 lessons.

### Suggested order of delivery

1 → 2 → 3 (the §1.4/§10 visible gaps and the biggest clutter) → 4 → 6 → 10 → 5 → 7 → 8 → 11 → 12 → 13 → 14 → 9 (later part) → 15 continuously. Items 1–4 and 6 are independent of each other apart from shared `styles.css` edits and can be split between two engineers on separate branches.
