# Split `app.js` (3,274 lines)

## Overview

`web/static/js/app.js` is the frontend's `store.go` equivalent: 3,274
lines, 100 top-level functions, **34 module-level mutable state
declarations**, mixing eight unrelated concerns:

1. Telegram WebApp bootstrap (lines 1–13).
2. Settings-bundle normalization (lines 50–80).
3. Server-time / TZ-info display (lines 82–200+).
4. Auth flow (`verifyAuthInBackground`, `clearSwBootstrapCache`,
   lines 350–390) and `checkAuth()`.
5. Bootstrap hydration (`applyBootstrapPayload`, ~line 217+) and
   Dexie hydration (`hydrateMedicationsFromDexie`, ~line 429).
6. Tab-binding + active-tab UI helpers (lines 1150+).
7. Today-tab refresh debouncer + interval timer (lines 2308–2309,
   2844).
8. **Weight-unit optimistic-write state machine** (lines 2110–2218 —
   five `let`s + 80 lines of comments documenting prior regressions).
9. Push-modal flow (lines 2978–2982).
10. Medication scheduling utilities (`getNextScheduledDate`, line 2707).
11. The shared `escapeHtml` primitive (line 2779).

This plan splits `app.js` into focused files (one concern per file),
each mounted as `window.X` and consumed by name. The split mirrors
the [Go store split plan](2026-05-13-split-store-package.md): one file
per concern, narrow public surface, module-level mutable state
forbidden in extracted files (architecture test).

The shape `features/today.js` already takes (1,212 lines, **zero**
module-level mutable state, single-IIFE export `window.TodayDashboard`)
is the target.

**Out of scope:**
- Splitting `features/workout.js` and `features/food.js` — separate
  [feature-file split plan](2026-05-13-split-workout-food-features.md).
- Replacing the global-namespace IPC bus with an event bus
  (recommended-priority item #6 dependency, separate plan if pursued).
- The MessengerAdapter abstraction (recommended-priority item #8,
  separate plan).

From the [2026-05-13 frontend review §2](../2026-05-13-frontend-code-review.md#2-appjs-and-featuresworkoutfoodjs-as-god-files)
and recommended-priority item #6.

## Context (from discovery)

- **34 module-level state declarations** in `app.js` (verified via
  `awk '/^(let|var|const) [a-zA-Z_]+/{print NR": "$0}' js/app.js`).
  The most racy cluster:
  - `weightUnitPatchTail` (line 2116)
  - `weightUnitIntentSeq` (line 2117)
  - `weightUnitLastCommitted` (line 2118)
  - `weightUnitPendingPatches` (line 2125)
  - `weightUnitLocallyMutated` (line 2135)
- **State that's globally mutable from multiple files**:
  - `var medications = []` at line 1077 — also written by
    `features/meds.js`
  - `var foodTargets = ...` at line 1080
  - `var currentFoodLogs = {}` at line 1079
  - `let featureSettings`, `let featureSettingsLoaded` at lines
    1086, 1094 — three different writers (lines 226-230, 341-345,
    414-420) all racing
- **Push-modal globals** (lines 2978-2982): `pendingMedConfirmIds`,
  `pendingMedConfirmScheduled`, `pendingWorkoutSessionId`,
  `pendingMedConfirmMode`, `pendingMedConfirmIntakeIds` — implicit
  invariant "at most one open at a time" undefended.
- **Dependency graph (read-only side)**: many feature files read
  `window.featureSettings`, `window.weightUnitPreference`,
  `window.userInitData` — pulled out by name, not by ownership.
  Splitting must preserve these names so callers don't break.
- **`escapeHtml`** (line 2779) is referenced from only 3 sites
  (`sync.js:59`, `app.js:2754` self, plus the test for it) but is the
  *only* shared escaping primitive. Should land in `core/utils.js` next
  to `safeAlert`.

## Development Approach

- **Testing approach**: Regular.
- One PR per extraction (5–7 small PRs total) is safer than one mega
  PR. Each task here = one extraction = one PR. The architecture test
  (last task) lands after every extraction is in.
- Backwards-compatible: each extracted file re-attaches the same
  `window.X` names; nothing renames or removes globals at this stage
  (rename is a separate follow-up).
- **Forbid module-level mutable state in extracted files** — the
  weight-unit cluster becomes an explicit reducer/state-machine
  exposed as `window.WeightUnitState`; settings hydration becomes a
  reducer in `window.SettingsHydrator`; etc.

## Testing Strategy

- **Unit tests**: required per extracted file. Each gets its own test
  file. The existing `app.unit.test.js`, `app.behavior-extended.test.js`,
  `app.tab-single-source.test.js`, etc. continue to load `app.js` and
  exercise it as a whole; no regression there.
- **Architecture test**: scan extracted files for `^(let|var)\s+\w+`
  at top level — fail any extracted file that adds module-level
  mutable state (state machines have one `let _state = ...` allowed
  with an explicit comment).

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for new tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Extract `core/escape-html.js` and `core/time-format.js`

- [x] move `escapeHtml` (`app.js:2779`) into `web/static/js/core/utils.js`
  next to `safeAlert`; expose as `window.escapeHtml`
- [x] move time-formatting utilities — `formatSettingsDateTime`
  (`app.js:92`), `parseRFC3339OffsetMinutes` (`app.js:105`),
  `formatFixedOffsetDateTime` (`app.js:114`), and
  `renderSettingsTimeInfo` — into `web/static/js/core/time-format.js`;
  expose as `window.TimeFormat.{...}`
- [x] update `app.js` to delete the moved functions and not re-define
  them
- [x] update existing callers (only `sync.js:59` uses `escapeHtml` by
  name; `renderSettingsTimeInfo` is called via `window.X`)
- [x] add `core/time-format.js` to `index.html` and `sw.js`
  `STATIC_ASSETS` (early — before `app.js`)
- [x] add `window.escapeHtml` and `window.TimeFormat` to
  `architecture.globals.test.js` allowlist
- [x] write tests in `web/static/js/tests/core.escape-html.test.js`
  (canonical behaviour: amp/lt/gt/quote/apos) and
  `web/static/js/tests/core.time-format.test.js` (RFC3339 offset
  parsing, fixed-offset render, locale fallback)
- [x] run `pnpm test core.escape-html core.time-format app.` — must
  pass before next task

### Task 2: Extract `features/weight-unit-state.js` (the racy cluster)

- [x] create `web/static/js/features/weight-unit-state.js` exporting
  `window.WeightUnitState` with the methods that today are scattered:
  - `commitAuthoritativeWeightUnit(unit)` (called from `app.js:411`,
    `app.js` ~lines 2150-2200)
  - `applyWeightUnitSegmentedState(unit)`
  - `reconcileAuthoritativeUnit(unit)` (line 2147 today)
  - The PATCH queueing loop (`weightUnitPatchTail`)
- [x] inside the new file, the five module-level `let`s become
  *closure-private* state behind a single `WeightUnitState` object
  (one allowed `let _state = { ... }` with documented invariants)
- [x] delete the corresponding code from `app.js` (lines ~2110-2218);
  replace with a thin shim that calls the new module
- [x] preserve `window.weightUnitPreference` (consumed by
  `features/weight.js`, `features/today.js`, `core/utils.js`) by
  keeping the state machine's "current effective unit" mirrored to
  that global on every transition
- [x] write tests in `web/static/js/tests/features.weight-unit-state.test.js`
  that exercise the regression scenarios documented in the original
  comments: A→B→A with tail PATCH failure (must revert to last
  server-confirmed, not optimistic); SW BOOTSTRAP_UPDATED carrying
  pre-PATCH unit (must be rejected when locally mutated); concurrent
  user clicks during in-flight PATCH (queue order preserved)
- [x] verify the existing `app.behavior-extended.test.js` and any
  weight-unit regression tests still pass
- [x] run `pnpm test features.weight-unit-state` and `pnpm test
  weight.` — must pass before next task

### Task 3: Extract `features/auth-bootstrap.js`

- [ ] create `web/static/js/features/auth-bootstrap.js` containing:
  - `verifyAuthInBackground` (`app.js:353`)
  - `clearSwBootstrapCache` (`app.js:379`)
  - `bootstrapURL` (`app.js:394`)
  - `hydrateFeatureSettingsFromBundle` (`app.js:407`)
  - `hydrateMedicationsFromDexie` (`app.js:429`)
  - `hydrateSectionsFromDexie` (currently part of `app.js`)
  - `applyBootstrapPayload` (the full hydration function)
  - `cacheApiSnapshot` (`app.js:37`)
  - `normalizeSettingsBundle` (`app.js:50`)
- [ ] expose as `window.AuthBootstrap.{...}`
- [ ] keep `checkAuth()` in `app.js` for now — it orchestrates the
  above and is the entry point; extracting it later
- [ ] **important**: `featureSettings` and `featureSettingsLoaded`
  must move into the new file as a small `window.SettingsState`
  reducer with `getFeatureSettings()`, `applyBootstrapFeatures(flags)`,
  `applyDexieFeatures(flags)`, `isLoaded()` — three writers race today
  (lines 226-230, 341-345, 414-420), so a single owning module ends
  the race
- [ ] update `app.js` to delegate
- [ ] write tests in `web/static/js/tests/features.auth-bootstrap.test.js`
  covering: bootstrap-then-Dexie-hydration order is idempotent;
  Dexie hydration after bootstrap does not stomp fresh values;
  `verifyAuthInBackground` triggers reload on 4xx, swallows on 5xx
- [ ] run `pnpm test features.auth-bootstrap app.` — must pass

### Task 4: Extract `features/push-modal.js`

- [ ] create `web/static/js/features/push-modal.js` containing the
  push-modal coordination state (lines 2978-2982:
  `pendingMedConfirmIds`, `pendingMedConfirmScheduled`,
  `pendingWorkoutSessionId`, `pendingMedConfirmMode`,
  `pendingMedConfirmIntakeIds`) plus the open/close/dispatch
  functions that consume them
- [ ] all five `var`s become a single `window.PushModalState`
  object's private fields; expose `openMedConfirm({ids, ...})`,
  `openWorkoutStart({sessionId})`, `clear()` — invariant "at most one
  open at a time" enforced by the API
- [ ] delete the corresponding code from `app.js`
- [ ] write tests in `web/static/js/tests/features.push-modal.test.js`
  covering: opening med while workout open clears workout (or refuses
  — pick deliberately); clear() resets all fields
- [ ] run `pnpm test features.push-modal app.` — must pass

### Task 5: Extract `features/medication-utils.js`

- [ ] move `parseMedicationSchedule`, `getNextScheduledDate`
  (`app.js:2707`), `getMedicationScheduleText` (`app.js:2752`),
  `getLastTakenTimeMs` (`app.js:2773`) into
  `web/static/js/features/medication-utils.js`; expose as
  `window.MedicationUtils.{...}`
- [ ] update `app.js` and any feature consumers to call via the
  module
- [ ] write tests in `web/static/js/tests/features.medication-utils.test.js`
  covering daily and weekly schedule next-date calculation, weekly
  cross-day boundary, edge cases (empty times, invalid time strings)
- [ ] run `pnpm test features.medication-utils today.` — must pass

### Task 6: Extract `features/tab-controller.js`

- [ ] move tab-binding helpers (`bindTabGroup`, `activateTabGroup`,
  the `dataset.tabBound` guard pattern from `app.js:1151-1152`,
  per-section tab persistence) into
  `web/static/js/features/tab-controller.js`; expose as
  `window.TabController.{...}`
- [ ] consolidate the three `*ControlsBound` flags
  (`medicationControlsBound` line 1783, `measurementControlsBound`
  line 1832, `notificationControlsBound` line 1869) into a single
  `TabController.bindOnce(scope, fn)` helper
- [ ] write tests in `web/static/js/tests/features.tab-controller.test.js`
  covering one-time binding, tab activation, sub-tab persistence
- [ ] run `pnpm test features.tab-controller app.` — must pass

### Task 7: Architecture test prevents regression

- [ ] add `web/static/js/tests/architecture.no-module-state.test.js`
  that scans `web/static/js/{core,features}/*.js` (excluding `app.js`
  and existing files explicitly grandfathered with a justification)
  and fails any file with `^(let|var) ` at column zero — i.e.
  module-level mutable state is forbidden in extracted files; one
  `let _state = ...` per file allowed if the line includes the comment
  `// module-state: <reason>` immediately after
- [ ] include the grandfather list (current files that have known
  module state pending extraction) and document each entry
- [ ] run `pnpm test architecture.no-module-state` — must pass

### Task 8: Verify acceptance

- [ ] line count: `wc -l web/static/js/app.js` shows < 1,500 lines
  (started at 3,274; conservatively expect 1,200-1,500 after the six
  extractions)
- [ ] `awk '/^(let|var) [a-zA-Z_]+/{print NR}' web/static/js/app.js |
  wc -l` shows fewer module-level state declarations (started at 34;
  expect ~10 after weight-unit, push-modal, settings extractions)
- [ ] full `pnpm test` clean
- [ ] grep for `weightUnitPatchTail` shows hits only in
  `features/weight-unit-state.js` (not `app.js`)
- [ ] grep for `pendingMedConfirmIds` shows hits only in
  `features/push-modal.js`
- [ ] grep for `escapeHtml` shows definition only in `core/utils.js`

## Technical Details

### `WeightUnitState` shape (Task 2)

```javascript
window.WeightUnitState = (function () {
    let _state = {
        patchTail: Promise.resolve(),
        intentSeq: 0,
        lastCommitted: null,
        pendingPatches: 0,
        locallyMutated: false,
    }; // module-state: weight-unit reducer; invariants in commitAuthoritative()

    function commitAuthoritative(unit) { /* ... */ }
    function reconcile(incoming) { /* ... */ }
    function patch(unit) { /* ... */ }

    return { commitAuthoritative, reconcile, patch };
})();
```

The single `let _state = {...}` annotation is the architecture-test
escape hatch (see Task 7); every other `let`/`var` at top level fails.

### Why six extractions, not one

Each extraction is independently reviewable, ships independently, and
the existing test suite (~175 tests) re-runs against the shimmed
`app.js` after each step — fast feedback. A single mega-PR that
extracts everything at once would be unreviewable.

### What stays in `app.js` after this plan

- `checkAuth()` orchestrator
- `loadSettings()` (the canonical Settings orchestrator)
- The Today-tab refresh debouncer (still has cross-cutting concerns)
- A handful of utility functions used only by `app.js`

A follow-up plan can split `checkAuth` and the Today refresh logic
once the extracted modules are battle-tested.

## Post-Completion

**Manual verification** (recommended after each task):
- After each PR merges, regression-test the affected concern in a
  real browser:
  - Task 2: switch weight unit kg/lb rapidly, verify no revert bug
  - Task 3: log out, log in via OIDC, verify bootstrap re-hydrates
  - Task 4: tap medication push notification, verify modal opens
  - Task 5: add a daily-schedule med, verify "next dose" math is
    correct
  - Task 6: switch tabs rapidly, verify no double-binding artifacts

**No external system updates needed.**
