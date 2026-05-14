# Split `features/workout.js` and `features/food.js`

## Overview

Two feature files have grown into mini god-objects that mirror the
[`app.js` problem](2026-05-13-split-app-js.md) at the feature scope:

- **`web/static/js/features/workout.js`** — 3,266 lines, 100 top-level
  functions, **21 module-level state declarations**, and 6 "currently
  editing" globals (`workoutGroups`, `currentEditingGroupId`,
  `currentEditingVariantId`, `currentEditingExerciseId`,
  `currentGroupForVariant`, `currentVariantForExercise` at lines
  7-12) whose implicit invariant — at most one is non-null at a time
  — is undefended.

- **`web/static/js/features/food.js`** — 2,796 lines, 81 top-level
  functions, 23 module-level state declarations. Mixes the daily food
  log, food-products search and cache, the camera-barcode scanner
  modal flow, the food-photo AI summary, the My Meals section, and the
  Daily/Weekly macros toggle.

`features/today.js` is the counter-example: 1,212 lines, **zero**
module-level mutable state, single IIFE export. The fact that it's
already in the codebase shows the shape is achievable.

This plan splits each fat feature into smaller files by sub-concern,
each with one owner and a narrow public surface, and forbids
module-level mutable state in the extracted files.

**Out of scope:**
- The `app.js` split (separate
  [plan](2026-05-13-split-app-js.md)).
- Replacing inter-feature global function calls with an event bus.
- Migrating the food-photo AI summary to the new MessengerAdapter
  shape (deferred).

From the [2026-05-13 frontend review §2](../2026-05-13-frontend-code-review.md#2-appjs-and-featuresworkoutfoodjs-as-god-files)
and recommended-priority item #7.

## Context (from discovery)

### `features/workout.js` concerns

By reading the file headers (lines 1-160) and grepping for
function-cluster patterns:

| Concern             | Approx lines       | Public surface today                          |
|---------------------|--------------------|-----------------------------------------------|
| Sub-tab routing     | 50–125             | `loadWorkouts`, `switchWorkoutTab`            |
| Workout groups CRUD | ~150–700           | `loadWorkoutGroups`, `saveWorkoutGroup`, ...  |
| Variants CRUD       | ~700–1100          | `saveVariant`, `closeVariantModal`, ...       |
| Exercises CRUD      | ~1100–1500         | `saveExercise`, `closeExerciseModal`, ...     |
| Exercise library    | ~1500–1800         | `loadExerciseLibrary`, `saveExerciseLibraryItem` |
| Workout sessions    | ~1800–2400         | `saveWorkoutSessionDetails`, `deleteWorkoutSession` |
| Mi-Band import      | ~2400–2700         | `closeMiBandWorkoutModal`, ...                |
| Stats sub-tab       | ~2700–2900         | `loadWorkoutStatsTab`                         |
| Next-workout card   | ~2900–3266         | `loadNextWorkout`, ad-hoc start/skip/snooze   |

The 6 "currently editing" globals (lines 7-12) get touched by 3-4
of those concerns; that's the cross-cutting state risk.

### `features/food.js` concerns

| Concern                 | Approx lines       | Public surface today                       |
|-------------------------|--------------------|--------------------------------------------|
| Day-nav + macros toggle | 1–200              | `setFoodMacrosRange`, `bindFoodControls`   |
| Daily food log          | 200–700            | `loadFoodLogs`, `addFoodLog`, ...          |
| Food product search     | 250–550 (streaming)| `searchFoodProducts`                       |
| Barcode scanner modal   | ~1100–1500         | `startFoodScanner`, `stopFoodScanner`      |
| Food photo capture      | ~1700–1900         | (touches `food-photo-summary.js` too)      |
| My Meals + meal compose | ~2300–2500         | `loadMyMeals`, `saveAsMeal`                |
| Food DB (browse)        | ~2600–2750         | `loadFoodDB`                               |
| Food modal forms        | scattered          | `editFoodLog`, `closeFoodModal`            |

Module-level state in `features/food.js`:
`foodControlsBound`, `FOOD_MACROS_RANGES`, `foodMacrosRange`,
`lastFoodLogsMeta`, `FOOD_LOGS_STALE_AFTER_MS`,
`foodSearchTimeout`, `foodSearchRequestId`,
`lastFoodSearchQueryNormalized`, `currentFoodLogs` (also in
app.js!), `currentFoodStatsPeriod`, etc. — 23 total.

## Development Approach

- **Testing approach**: Regular.
- One PR per file split, two PRs total (workout split, food split).
- Each split follows the same shape as the `today.js` IIFE pattern:
  one wrapper, one private state object, public API mounted on
  `window.X`.
- The cache-key migration done in the
  [cache-key registry plan](2026-05-13-cache-key-registry.md) Task 3
  is a soft prerequisite (avoids re-touching cache logic during the
  split); not strictly blocking.

## Testing Strategy

- **Unit tests**: most existing tests (`workout.subtabs`, `workout.modal`,
  `workout.stats`, `workout.history`, `workout.invalidation`,
  `food.meallist`, `food.modal`, `food.daynav`, `food.dexie-hydration`,
  etc.) load the original feature file. Each split file gets a focused
  test covering its sub-concern; existing aggregate tests continue to
  pass.
- **Architecture test**: extend `architecture.no-module-state.test.js`
  (introduced in the app.js split plan, Task 7) to also cover the
  newly extracted files.

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for new tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Carve `features/workout.js` into sub-files

- [x] create `web/static/js/features/workout/` directory; move
  `features/workout.js` → `features/workout/index.js` as a thin
  orchestrator (sub-tab routing only — Sub-tab block above)
- [x] extract `features/workout/groups.js` — workout-groups CRUD
  (loadWorkoutGroups, showAddWorkoutGroupModal, saveWorkoutGroup,
  deleteWorkoutGroup, closeWorkoutGroupModal); expose as
  `window.WorkoutGroups`
- [x] extract `features/workout/variants.js` — variants CRUD; expose
  as `window.WorkoutVariants`
- [x] extract `features/workout/exercises.js` — exercises-within-variants
  CRUD; expose as `window.WorkoutExercises`
- [x] extract `features/workout/library.js` — exercise library;
  expose as `window.WorkoutLibrary`
- [x] extract `features/workout/sessions.js` — workout sessions
  (CRUD, save details, add-exercise-to-session, delete session,
  ad-hoc start, snooze, skip); expose as `window.WorkoutSessions`
- [x] extract `features/workout/miband.js` — Mi-Band import flow;
  expose as `window.WorkoutMiBand`
- [x] extract `features/workout/stats.js` — stats sub-tab loader;
  expose as `window.WorkoutStats`
- [x] extract `features/workout/history.js` — history sub-tab loader
  (`loadWorkoutHistoryTab`); expose as `window.WorkoutHistory`
- [x] extract `features/workout/next-card.js` — next-workout card
  + ad-hoc affordances; expose as `window.WorkoutNextCard`
- [x] **eliminate the 6 "currently editing" globals** by moving each
  into the closure of the file that owns the editing flow
  (currentEditingGroupId → groups.js; currentEditingVariantId +
  currentGroupForVariant → variants.js; currentEditingExerciseId +
  currentVariantForExercise → exercises.js); use a single
  `window.WorkoutEdit.openSomething(id)` API per concern, mutually
  exclusive at the surface level
- [x] update `web/static/index.html` and `web/static/sw.js`
  `STATIC_ASSETS` to load the new files in dependency order
  (orchestrator last)
- [x] update `web/static/js/tests/architecture.globals.test.js`
  allowlist for the new `window.WorkoutX` names
- [x] write `web/static/js/tests/features.workout-groups.test.js`,
  `features.workout-variants.test.js`, etc. — one focused test file
  per extracted file, covering at minimum: open-edit, save, close
  flows
- [x] verify all existing `workout.*.test.js` tests still pass
  unchanged
- [x] run `pnpm test workout.` — must pass before next task

### Task 2: Carve `features/food.js` into sub-files

- [ ] create `web/static/js/features/food/` directory; move
  `features/food.js` → `features/food/index.js` as orchestrator
  (day-nav + macros-toggle binding)
- [ ] extract `features/food/log.js` — daily food log
  (loadFoodLogs, addFoodLog, editFoodLog, deleteFoodLog,
  closeFoodModal); expose as `window.FoodLog`
- [ ] extract `features/food/products.js` — product search (the
  streaming `searchFoodProducts`, `foodSearchTimeout` /
  `foodSearchRequestId` state lives in this file's closure); expose
  as `window.FoodProducts`
- [ ] extract `features/food/scanner.js` — barcode scanner modal
  (startFoodScanner, stopFoodScanner, setFoodScannerStatus); expose
  as `window.FoodScanner`
- [ ] extract `features/food/photo.js` — food photo capture entry
  point (does NOT swallow `food-photo-summary.js`; remains a coordinator
  between this file and the existing summary helper); expose as
  `window.FoodPhoto`
- [ ] extract `features/food/meals.js` — My Meals section + save-as-
  meal flow; expose as `window.FoodMeals`
- [ ] extract `features/food/db.js` — Food DB browse panel; expose
  as `window.FoodDB`
- [ ] **eliminate `currentFoodLogs` duplicate** between
  `app.js:1079` and `features/food.js`; canonical location =
  `features/food/log.js` closure, accessed via `window.FoodLog.getCurrent()`;
  delete the `app.js` `var`
- [ ] update `web/static/index.html` and `web/static/sw.js`
  `STATIC_ASSETS`
- [ ] update `architecture.globals.test.js` allowlist
- [ ] write `web/static/js/tests/features.food-log.test.js`,
  `features.food-products.test.js`, etc. — focused per-file
- [ ] verify existing `food.*.test.js` tests still pass
- [ ] run `pnpm test food.` — must pass before next task

### Task 3: Wire architecture test

- [ ] extend `architecture.no-module-state.test.js` (from the app.js
  split plan) to also enforce on the new `features/workout/*.js` and
  `features/food/*.js` files; the orchestrator may carry the one
  allowed `let _state` (annotated)
- [ ] add the new sub-files to the `architecture.offline-coverage.test.js`
  allowlist or wire them through `cachedFetch` /
  `offlineAwareApiCall` per the existing rules
- [ ] run `pnpm test architecture.` — must pass before next task

### Task 4: Verify acceptance

- [ ] line count: `wc -l web/static/js/features/workout/*.js` shows
  no single file > 800 lines; orchestrator < 200 lines
- [ ] line count: `wc -l web/static/js/features/food/*.js` shows
  no single file > 700 lines; orchestrator < 200 lines
- [ ] grep for `currentEditingGroupId\|currentEditingVariantId\|currentEditingExerciseId`
  shows hits only inside their respective owner files
- [ ] grep for `var currentFoodLogs` returns hits only in
  `features/food/log.js` (deleted from `app.js`)
- [ ] full `pnpm test` clean
- [ ] manually open the app and exercise both features end-to-end:
  workout group → variant → exercise create + edit + delete; food
  log + scanner + meals + DB

## Technical Details

### Sub-file shape (workout/groups.js example)

```javascript
window.WorkoutGroups = (function () {
    let _state = { editingGroupId: null }; // module-state: form-edit lifecycle

    async function load() { /* ... */ }
    async function save() { /* ... */ }
    function open(id) { _state.editingGroupId = id; ModalManager.workoutGroup.open(); }
    function close() { _state.editingGroupId = null; ModalManager.workoutGroup.close(); }

    return { load, save, open, close };
})();
```

### Why this is two PRs, not one

Workout and Food are independent. Splitting both in one PR doubles
review burden. Ship workout first; let it bake one release; ship food
second. If something regresses in workout, food is unaffected.

### Why subdirectories not flat files

`features/workout-groups.js` vs `features/workout/groups.js`: the
nested form makes the orchestration boundary explicit (`workout/index.js`
is the entry point) and groups related files when navigating the file
tree. The SW precache list and index.html script tags handle nested
paths fine.

## Post-Completion

**Manual verification** (recommended after each task):
- Workout flow: create group → variant → exercise → save session →
  delete; verify no double-modal opens, no orphan state.
- Food flow: scan barcode → add meal → save-as-meal → reuse meal
  → delete; verify scanner closes properly when food modal opens.

**No external system updates needed.**
