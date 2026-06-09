# Finish the `app.js` split (round 2: Today, Settings, medication modal/history, workout modals)

## Overview

The 2026-05-13 split plan
(`docs/plans/completed/2026-05-13-split-app-js.md`) extracted the utility
and state-machine layers (escape-html, time-format, weight-unit-state,
auth-bootstrap, push-modal, medication-utils, tab-controller) and brought
`app.js` from 3,274 → 2,517 lines. It has since grown back to **2,910
lines** because the big *view orchestrators* were left in place. This
plan extracts them, targeting **app.js < 1,200 lines** containing only:
messenger bootstrap, `checkAuth()` orchestration, `switchTab()` / section
lifecycle, and top-level wiring.

Strictly behavior-preserving: every extracted module re-attaches the
same `window.*` names; no renames, no UX changes.

## Context (from discovery)

Current responsibility clusters in `web/static/js/app.js` (~2,910 lines):

| Cluster | Approx. lines | Key functions |
|---|---|---|
| Messenger bootstrap + auth | 1–200 | `checkAuth()`, `loadInitData()` |
| Today view orchestration | 691–1290 | `loadToday()`, `_todayRender()`, `_todayReadCaches()`, `fetchNextIntakePayload()` |
| Settings view | ~1459–1700+ | `loadSettings()`, `toggleFeatureSetting()`, `renderSettingsStaleBadge()` |
| Medication modal + history | ~1841–2500 | `showAddModal()`, `loadHistory()`, `updateIntakeHistory()`, `confirmSelectedMedications()`, `skipSelectedMedications()` |
| Workout start/snooze/skip modals | ~2776–2870 | `showWorkoutStartModal()`, `startWorkoutFromModal()`, `snoozeWorkout()`, `skipWorkout()` |

Constraints discovered:

- `architecture.mobile-no-telegram-login.test.js` inspects `app.js`
  content around `checkAuth()` — **`checkAuth()` must stay in `app.js`**
  (or that test must be updated in the same task, carefully preserving
  its intent: no Telegram login UI reachable from the embedded-shell
  branch).
- `architecture.globals.test.js` allowlists ~101 `window.*` globals; any
  new module global (e.g. `window.SettingsView`) needs an allowlist
  entry with justification.
- `architecture.no-module-state.test.js` (from round 1) forbids
  module-level `let`/`var` in extracted files — one annotated
  `let _state = …` allowed per file; app.js itself is grandfathered.
  Extracted code must convert its module-level state to closure-private
  state; remove the corresponding grandfather entries if any.
- Script load order lives in `web/static/index.html` (app.js loads at
  ~line 1739, after core/, data layer, native/, and most features/);
  `sw.js` `STATIC_ASSETS` must list every new file (offline precache).
- Frontend tests load files individually via
  `tests/helpers/frontend-harness.js`; splitting doesn't break loading,
  but suites that grep/exercise app.js directly (`app.unit.test.js`,
  `app.behavior-extended.test.js`, `app.tab-single-source.test.js`)
  must stay green.
- `features/today.js` (1,237 lines, `window.TodayDashboard`, zero
  module-level state) is the target shape for extracted modules — but
  note app.js's Today cluster is *separate* code that orchestrates
  loading, not a duplicate of `features/today.js`.
- Per CLAUDE.md rule 8 (integration-first testing): new behavior tests
  go into the owning feature suite via the harness — do not create
  coverage-driven standalone files.

## Development Approach

- **Testing approach**: Regular (code first, then tests).
- One extraction per task; complete each fully (code + index.html +
  sw.js + allowlist + tests green) before the next.
- **CRITICAL: every task MUST include new/updated tests** for the moved
  code — extend the owning feature suite (`features.*` /
  `<feature>.<aspect>.test.js`) through the frontend harness; success
  and error scenarios both.
- **CRITICAL: all tests must pass before starting next task** (`pnpm test`).
- **CRITICAL: update this plan file when scope changes during implementation.**
- Backwards-compatible: extracted modules re-attach the exact same
  `window.*` names; callers keep working untouched.
- No module-level mutable state in extracted files (architecture test
  enforces); convert to closure-private `_state` with the
  `// module-state: <reason>` annotation where genuinely needed.
- No hardcoded colors / inline `.style.` assignments may be introduced
  while moving code (architecture tests enforce).

## Testing Strategy

- **Unit/integration tests**: per task, in the owning feature suite via
  `tests/helpers/frontend-harness.js`. Existing app.* suites are the
  behavior-preservation net and must pass unmodified (mechanical
  load-list updates in the harness are OK; expectation changes are not).
- **E2E tests**: none in this repo's frontend pipeline; `pnpm test`
  (Vitest + jsdom) is the gate.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.

## Implementation Steps

### Task 1: Extract `features/meds-history.js` (medication modal + intake history)

- [x] create `web/static/js/features/meds-history.js` containing the
  medication modal + history cluster from `app.js` (~1841–2500):
  `showAddModal()`, `loadHistory()`, `updateIntakeHistory()`,
  `renderNextIntakeTrigger()`, `confirmSelectedMedications()`,
  `skipSelectedMedications()` and their private helpers; expose under a
  single `window.MedsHistory` namespace while re-attaching any function
  names that other files or inline `onclick` handlers call directly
  (grep `web/static/` for each name before deciding)
  — extracted as a plain global script (matching the sibling
  `features/meds.js` convention): bare `function` declarations stay the
  live call path (no inline `onclick` callers found; app.js bindings use
  call-time arrow wrappers; `features/meds.js` reaches the optimistic
  helpers via `typeof` guards), and `window.MedsHistory` mirrors the
  public surface. `handlePushAction` stayed in app.js as top-level push
  wiring; the workout modals stay for Task 4.
- [x] convert any module-level state to closure-private `_state`
  — `let _nextIntakeTimerInterval` became the annotated
  `let _state = { nextIntakeTimer: null }; // module-state: …` form that
  `architecture.no-module-state.test.js` permits.
- [x] delete the moved code from `app.js`; leave one-line delegation
  shims only where an existing global name must keep working
  — moved code deleted, replaced by two pointer comments; no shims
  needed (bare globals already keep callers working). app.js 2910 → 2005.
- [x] add the file to `index.html` (before `app.js`) and to `sw.js`
  `STATIC_ASSETS`
  — added after `features/meds.js` in both. (app.js loads first in this
  repo; feature files follow — call-time resolution makes order safe.)
- [x] add `window.MedsHistory` to the `architecture.globals.test.js`
  allowlist with justification
- [x] extend the meds feature suite (via frontend harness) covering:
  history load + render, intake confirm happy path, confirm failure
  surfaces error (regression: PR #384 revert behavior), skip path
  — added a `meds-history confirm/skip flows` describe to
  `app.medication-history.test.js` (confirm happy/throw-rollback/
  falsy-rollback + skip happy/error); existing loadHistory/updateIntake
  coverage now exercises the extracted module through the harness, which
  loads `meds-history.js` after `meds.js`.
- [x] run `pnpm test` — must pass before task 2
  — 240 files / 2596 passed, 29 skipped, 0 failed.

### Task 2: Extract `features/settings.js` (Settings view)

- [ ] create `web/static/js/features/settings.js` with `loadSettings()`,
  `toggleFeatureSetting()`, `renderSettingsStaleBadge()`, the timezone
  info rendering glue, and Integrations section logic from `app.js`
  (~1459–1700+); expose as `window.SettingsView` and keep
  `window.renderSettingsTimeInfo` / `window.initOIDCSetupBanner`
  attached to the same names
- [ ] feature-toggle writes must keep their current data-flow contract
  (CLAUDE.md rule 9 — if the current code uses `applyOptimistic`, keep
  it; do not "fix" patterns mid-move)
- [ ] delete moved code from `app.js`; update `index.html` + `sw.js`
- [ ] allowlist `window.SettingsView` in `architecture.globals.test.js`
- [ ] extend the settings/sections feature suite: settings render from
  warm cache, feature toggle flips nav visibility, stale badge mounts
- [ ] run `pnpm test` — must pass before task 3

### Task 3: Extract `features/today-loader.js` (Today orchestration)

- [ ] move the Today cluster from `app.js` (~691–1290) — `loadToday()`,
  `_todayRender()`, `_todayReadCaches()`, `fetchNextIntakePayload()`,
  the refresh debouncer + interval timer — into a new
  `web/static/js/features/today-loader.js` exposed as
  `window.TodayLoader`; first check overlap with
  `features/today.js` (`window.TodayDashboard`) and merge into that file
  instead if the cluster is really its loading layer (prefer one owning
  module over two — decide by reading both, note the decision here)
- [ ] keep `window.requestTabRefresh` / `window.reloadCurrentTab`
  semantics identical (they are allowlisted globals other features call)
- [ ] `switchTab()` stays in `app.js` (section lifecycle is the
  orchestrator's job)
- [ ] delete moved code from `app.js`; update `index.html` + `sw.js`;
  allowlist any new global
- [ ] extend the today feature suite: dashboard renders from caches
  offline, refresh debouncer coalesces rapid calls, next-intake payload
  fetch error path
- [ ] run `pnpm test` — must pass before task 4

### Task 4: Extract workout modal helpers into `features/workout/`

- [ ] move `showWorkoutStartModal()`, `startWorkoutFromModal()`,
  `snoozeWorkout()`, `skipWorkout()` (~2776–2870) into the existing
  `web/static/js/features/workout/` directory (new `modals.js` or the
  most fitting existing file — `sessions.js` if cohesive); re-attach
  the same global names used by push-modal / inline handlers
- [ ] delete moved code from `app.js`; update `index.html` + `sw.js` if
  a new file was created; allowlist any new namespace global
- [ ] extend the workout feature suite: start-from-modal calls the right
  endpoint optimistically, snooze and skip paths, failure rollback
- [ ] run `pnpm test` — must pass before task 5

### Task 5: Verify acceptance criteria

- [ ] `wc -l web/static/js/app.js` < 1,200 lines
- [ ] `awk '/^(let|var) [a-zA-Z_]+/{print NR}' web/static/js/app.js | wc -l`
  did not grow (was 9 after round 1)
- [ ] what remains in `app.js` is only: messenger bootstrap,
  `checkAuth()`, `switchTab()` / section lifecycle, top-level wiring —
  document any justified leftovers in a header comment
- [ ] `architecture.mobile-no-telegram-login.test.js` passes unmodified
  (checkAuth untouched)
- [ ] `architecture.no-module-state.test.js` passes; grandfather list
  shrank or stayed equal (never grew)
- [ ] every new file is in both `index.html` and `sw.js` `STATIC_ASSETS`
  (grep-compare the two lists)
- [ ] full `pnpm test` clean; `go test ./...` untouched and green
- [ ] run linter if configured — all issues fixed

### Task 6: [Final] Update documentation

- [ ] update `docs/frontend.md` load-order / module list for the new files
- [ ] note in `docs/plans/completed/2026-05-13-split-app-js.md`'s
  "follow-up" framing is now superseded by this plan (one-line pointer)
- [ ] update CLAUDE.md only if a rule-level statement changed (likely
  nothing — verify)

## Technical Details

- **Extraction mechanics** (same recipe as round 1): IIFE module exposing
  one `window.X` namespace; closure-private `_state` with documented
  invariants; existing global function names preserved via direct
  re-attachment (`window.showAddModal = MedsHistory.showAddModal`) only
  where grep shows external callers — otherwise keep them private.
- **Load order**: extracted files must load *before* `app.js` (which may
  still reference them during init) — insert in `index.html` next to
  their feature siblings; mirror in `sw.js` `STATIC_ASSETS` or offline
  mode breaks silently.
- **Inline `onclick` handlers** in HTML templates are the main hidden
  coupling: grep `web/static/index.html` and template strings for each
  moved function name before privatizing it.
- **Why these four clusters**: they are view orchestrators with no
  cross-dependencies on each other; each extraction is independently
  shippable and reviewable, mirroring round 1's one-extraction-per-task
  structure.

## Post-Completion

**Manual verification** (real browser, after merge):
- Today dashboard loads and auto-refreshes; medication confirm/skip from
  the Today card works and reverts correctly on failure.
- Settings: toggling a feature hides/shows its nav slot; timezone info
  renders; stale badge appears offline.
- Workout push notification → start modal → session starts.
- Mobile APK smoke test: embedded shell boots straight to the app with
  no Telegram login UI (`scripts/verify-apk.sh` + manual launch).

**External system updates**: none.
