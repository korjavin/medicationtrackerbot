# Frontend test-suite triage inventory (2026-05-15)

Working note for plan `2026-05-14-frontend-test-suite-moderate-prune.md`. Generated
at the start of Task 1; **deleted in Task 6** once the prune lands.

## Suite size and drift from the plan

- Files matched by `web/static/js/tests/*.test.js` today: **219**
- Plan's quoted baseline: 203 — i.e. the suite has grown by ~16 files since the plan
  was written. The plan's enumerated candidate set still resolves cleanly (no plan
  candidate is missing), so Tasks 2–5 proceed as written, but Task 7's count check
  needs to be read against the 219 baseline (target ~150, expected post-prune ~188 —
  see "Gap from target" below).

## Category counts

| Category | Count | Notes |
|----------|-------|-------|
| architecture | 12 | keep — guardrails |
| component (`components.wg-*`) | 13 | keep — web components without integration peer |
| infra (`db.*`, `sw-*`, `cached-fetch.*`, `data-store.*`, `bootstrap.*`) | 20 | keep — cross-cutting |
| feature (`features.*`, `<feature>.<aspect>`) | 142 | keep — integration-style |
| consolidate-candidate (`modals.*.header-actions`) | 11 | Task 2 — collapse into 1 file |
| obsolete-candidate (task-stamp / removed-feature pins) | 5 | Task 3 |
| coverage-candidate (`*branches*`, `*edges*`, `*characterization*`, `*-extended`) | 11 | Task 4 |
| duplicate-candidate (legacy `app.*` siblings of feature suites) | 5 | Task 5 |

## Gap from target

Plan target: ~150 files (range 145–160). Sum of planned deletions:
**11 (consolidate, +1 new) + 5 (obsolete) + 11 (coverage) + 5 (duplicate) = 31 net
files removed**, landing at **219 − 31 = 188**.

This is above the plan's 145–160 target. The plan was written against the 203-file
baseline (would have landed at 172). Decision recorded here so Task 7 doesn't treat
188 as a failure: the inventory's keep-rule audit (below) does not surface
additional safe deletions, and the plan explicitly forbids re-bloating the suite by
inventing new prune targets beyond the enumerated candidates. Document the final
count in the PR description as agreed in Task 7.

## Per-file inventory

| File | Lines | it() | Top describe | Category |
|------|-------|------|--------------|----------|
| architecture.cache-keys.test.js | 139 | 1 | Architecture – cache-keys registry guard | architecture |
| architecture.chart-theme.test.js | 185 | 11 | architecture — shared chart theme (Round-2 Task 13 / defect 16) | architecture |
| architecture.design-tokens.test.js | 1647 | 18 | Architecture – design tokens | architecture |
| architecture.globals.test.js | 230 | 1 | Architecture – window globals guard | architecture |
| architecture.inline-styles.test.js | 120 | 1 | Architecture – Food inline-styles guard | architecture |
| architecture.no-inline-handlers.test.js | 827 | 17 | Architecture – no CSP-blocked inline event handlers | architecture |
| architecture.no-module-state.test.js | 184 | 5 | Architecture – no module-level mutable state in split files | architecture |
| architecture.offline-coverage.test.js | 229 | 4 | Architecture – offline coverage allowlist | architecture |
| architecture.sw-precache.test.js | 138 | 4 | Service Worker precache coverage | architecture |
| architecture.sync-factory.test.js | 251 | 2 | Architecture – sync-pipeline-factory single-call-site guard | architecture |
| architecture.toolbar-btn.test.js | 277 | 16 | Round-2 Task 2 — shared .wg-toolbar-btn class | architecture |
| architecture.wg-primitives.test.js | 227 | 17 | Wandergeek material primitives | architecture |
| components.wg-bottom-nav.test.js | 381 | 30 | WGBottomNav — component | component |
| components.wg-bp-chart.test.js | 381 | 23 | WGBpChart.render | component |
| components.wg-macro-bar.test.js | 146 | 15 | WGMacroBar.render | component |
| components.wg-modal.test.js | 144 | 7 | Wandergeek modal structural DOM | component |
| components.wg-phone-chrome.test.js | 190 | 10 | WGPhoneChrome | component |
| components.wg-sleep-chart.test.js | 243 | 17 | WGSleepChart.render | component |
| components.wg-sparkline.test.js | 110 | 9 | WGSparkline.render | component |
| components.wg-stale-badge.test.js | 137 | 12 | WGStaleBadge.render | component |
| components.wg-steps-chart.test.js | 253 | 20 | WGStepsChart.render | component |
| components.wg-toggle.test.js | 139 | 8 | WGToggle | component |
| components.wg-vitals-chart.test.js | 287 | 21 | WGVitalsChart.render | component |
| components.wg-weight-chart.test.js | 319 | 22 | WGWeightChart.render | component |
| components.wg-workout-chart.test.js | 230 | 16 | WGWorkoutChart.render | component |
| modals.bp.header-actions.test.js | 76 | 6 | BPModal header-actions | consolidate-candidate |
| modals.food.header-actions.test.js | 66 | 5 | EditFoodModal header-actions | consolidate-candidate |
| modals.meds.header-actions.test.js | 66 | 5 | MedModal header-actions | consolidate-candidate |
| modals.note.header-actions.test.js | 74 | 6 | NoteModal header-actions | consolidate-candidate |
| modals.weight.header-actions.test.js | 75 | 6 | WeightModal header-actions | consolidate-candidate |
| modals.workouts-exercise.header-actions.test.js | 63 | 5 | WorkoutExerciseModal header-actions | consolidate-candidate |
| modals.workouts-group.header-actions.test.js | 64 | 5 | WorkoutGroupModal header-actions | consolidate-candidate |
| modals.workouts-library.header-actions.test.js | 63 | 5 | WorkoutLibraryModal header-actions | consolidate-candidate |
| modals.workouts-log-set.header-actions.test.js | 63 | 5 | WorkoutLogSetModal header-actions | consolidate-candidate |
| modals.workouts-start.header-actions.test.js | 83 | 6 | WorkoutStartModal header-actions | consolidate-candidate |
| modals.workouts-variant.header-actions.test.js | 64 | 5 | WorkoutVariantModal header-actions | consolidate-candidate |
| app.behavior-extended.test.js | 128 | 6 | app.js extended behavior coverage | coverage-candidate |
| app.bp-weight-data-and-export-branches.test.js | 252 | 5 | app.js BP/weight data and export branch coverage | coverage-candidate |
| app.loadmeds-bp-swipe-edges.test.js | 66 | 2 | app.js loadMeds/BP edge branches | coverage-candidate |
| app.med-modal-and-history-branches.test.js | 304 | 7 | app.js medication modal CRUD and history edge branches | coverage-candidate |
| app.push-actions-and-modal-history-branches.test.js | 109 | 3 | app.js push actions and modal history branch coverage | coverage-candidate |
| app.ui-characterization.test.js | 177 | 7 | app.js UI characterization | coverage-candidate |
| sync.fallback-branches.test.js | 143 | 5 | sync.js fallback branch coverage | coverage-candidate |
| sync.misc.test.js | 64 | 2 | sync.js misc helpers | coverage-candidate |
| workout.branch-guards-and-errors.test.js | 254 | 4 | workout.js guard and error branches | coverage-candidate |
| workout.swr-and-modal-edges.test.js | 296 | 5 | workout.js SWR and modal edge branches | coverage-candidate |
| workout.ui-characterization.test.js | 73 | 3 | workout.js UI characterization | coverage-candidate |
| app.deeplinks-and-push.test.js | 306 | 12 | handleDeepLinks – path deep links | duplicate-candidate |
| app.forms-and-push.test.js | 463 | 14 | app.js form submissions and push modal behavior | duplicate-candidate |
| app.gestures-and-notifications.test.js | 42 | 1 | app.js test notification flows | duplicate-candidate |
| app.medication-history.test.js | 456 | 9 | app.js medication, history and intake flows | duplicate-candidate |
| app.modal-history.test.js | 137 | 6 | app.js modal history and back behavior | duplicate-candidate |
| app.auth-check.test.js | 151 | 5 | app.js checkAuth behavior | feature |
| app.bp-weight-global-scope.test.js | 66 | 5 | bp/weight feature globals are available after full env load | feature |
| app.checkauth-nonblocking.test.js | 351 | 12 | checkAuth non-blocking with cached bootstrap | feature |
| app.dexie-hydration.test.js | 160 | 5 | app.js cold-start Dexie hydration | feature |
| app.food-crud-and-targets.test.js | 445 | 9 | app.js food CRUD, targets and period helpers | feature |
| app.food-products.test.js | 266 | 8 | food product edit/delete in autocomplete | feature |
| app.food-utils.test.js | 352 | 13 | app.js food helpers | feature |
| app.log-past-history.test.js | 284 | 3 | app.js log-past -> history reflects new intake | feature |
| app.med-confirm-edit-modes.test.js | 159 | 4 | app.js medication confirm edit/log modes | feature |
| app.refresh-dispatch.test.js | 104 | 3 | app.js refresh dispatch behavior | feature |
| app-shell.sw-token.test.js | 319 | 14 | app-shell.js — SW auth-token handoff | feature |
| app.unit.test.js | 412 | 14 | app.js unit tests | feature |
| app.visual-and-scanner.test.js | 383 | 6 | app.js charts, scanner and visualization helpers | feature |
| app.weight-ruler-and-workout-start.test.js | 130 | 4 | app.js weight modal helpers and workout start modal flows | feature |
| bp.averages.test.js | 109 | 5 | renderBPAverages (Phase 3, Task 4) | feature |
| bp.delete-refresh.test.js | 114 | 3 | _deleteBPApi awaits loadBPReadings before resolving | feature |
| bp.design-parity.test.js | 150 | 7 | BP round-2 design parity | feature |
| bp.dexie-hydration.test.js | 223 | 6 | BP cold-start Dexie hydration (Task 1) | feature |
| bp.history.test.js | 299 | 14 | renderBPReadings (Phase 3, Task 5) | feature |
| bp.list-refresh.test.js | 139 | 2 | BP list refresh after add + delete (Round-2 Task 5, #7a/#7b) | feature |
| bp.render.test.js | 241 | 16 | BP screen render helpers (Phase 3, Task 3) | feature |
| core.api-abort.test.js | 228 | 10 | apiCallDirect — timeout / AbortSignal support | feature |
| core.app-kernel.test.js | 145 | 9 | AppKernel | feature |
| core.cache-keys.test.js | 195 | 16 | core/cache-keys.js — static-key registry | feature |
| core.chart-utils.test.js | 643 | 48 | ChartUtils | feature |
| core.components.test.js | 156 | 10 | createEmptyState | feature |
| core.escape-html.test.js | 91 | 7 | escapeHtml | feature |
| core.modal-controller.test.js | 95 | 6 | withSubmit | feature |
| core.store.test.js | 111 | 8 | AppStore | feature |
| core.time-format.test.js | 205 | 18 | TimeFormat | feature |
| features.auth-bootstrap.test.js | 297 | 14 | features/auth-bootstrap.js — SettingsState reducer | feature |
| features.back-button.test.js | 253 | 11 | features/back-button.js — Telegram BackButton for section navigation | feature |
| features.call-indicator.test.js | 466 | 26 | features/call-indicator.js — persistent call-state pill | feature |
| features.elevenlabs-call.test.js | 635 | 21 | features/elevenlabs-call.js — exposed API surface | feature |
| features.food-db.test.js | 85 | 4 | features/food/db.js — split-file integration | feature |
| features.food-log.test.js | 102 | 5 | features/food/log.js — split-file integration | feature |
| features.food-meals.test.js | 92 | 5 | features/food/meals.js — split-file integration | feature |
| features.food-photo.test.js | 69 | 4 | features/food/photo.js — split-file integration | feature |
| features.food-products.test.js | 85 | 5 | features/food/products.js — split-file integration | feature |
| features.food-scanner.test.js | 75 | 5 | features/food/scanner.js — split-file integration | feature |
| features.medication-utils.test.js | 252 | 21 | features/medication-utils.js — MedicationUtils (Plan 2026-05-13, Task 5) | feature |
| features.push-modal.test.js | 180 | 11 | features/push-modal.js — PushModalState (Plan 2026-05-13, Task 4) | feature |
| features.tab-controller.test.js | 280 | 17 | features/tab-controller.js — TabController (Plan 2026-05-13, Task 6) | feature |
| features.weight-unit-state.test.js | 207 | 7 | features/weight-unit-state.js (Plan 2026-05-13, Task 2) | feature |
| features.workout-exercises.test.js | 77 | 4 | features/workout/exercises.js — split-file integration | feature |
| features.workout-groups.test.js | 79 | 4 | features/workout/groups.js — split-file integration | feature |
| features.workout-history.test.js | 59 | 3 | features/workout/history.js — split-file integration | feature |
| features.workout-library.test.js | 73 | 4 | features/workout/library.js — split-file integration | feature |
| features.workout-miband.test.js | 78 | 4 | features/workout/miband.js — split-file integration | feature |
| features.workout-next-card.test.js | 92 | 5 | features/workout/next-card.js — split-file integration | feature |
| features.workout-sessions.test.js | 85 | 4 | features/workout/sessions.js — split-file integration | feature |
| features.workout-stats.test.js | 52 | 4 | features/workout/stats.js — split-file integration | feature |
| features.workout-variants.test.js | 71 | 4 | features/workout/variants.js — split-file integration | feature |
| food.actions-photo-picker.test.js | 100 | 4 | window.FoodActions.triggerPhotoPicker (friendly food-photo flow, Task 5) | feature |
| food.cache-keys.test.js | 119 | 4 | food cache keys + family-tag invalidation | feature |
| food.daynav.test.js | 241 | 14 | Food day-navigator (Phase 4, Task 3) | feature |
| food.design-parity.test.js | 129 | 5 | Food round-2 design parity | feature |
| food.dexie-hydration.test.js | 326 | 8 | Food cold-start Dexie hydration (Task 5) | feature |
| food.exif-eaten-at.test.js | 303 | 16 | readFoodPhotoExifDateFromBuffer | feature |
| food.fooddb.test.js | 185 | 9 | Food → Food DB panel (Phase 4 follow-up, Task 5) | feature |
| food.macros.test.js | 267 | 15 | Food daily macros card (Phase 4, Task 4) | feature |
| food.mealdb.test.js | 156 | 6 | Food → Meal DB panel (Phase 4 follow-up, Task 5) | feature |
| food.meallist.test.js | 364 | 17 | Food meal-grouped item list (Phase 4, Task 5) | feature |
| food.modal.test.js | 323 | 18 | EditFoodModal (Phase 4, Task 6) | feature |
| food.offline-cached-fetch.test.js | 277 | 6 | Food loadFoodLogs() local-first read resilience | feature |
| food-photo-summary.test.js | 204 | 10 | showFoodPhotoSummary (friendly food-photo flow, Task 3) | feature |
| food.product-link.test.js | 124 | 5 | editFoodLog product-link wiring (CSP-safe) | feature |
| food.search-abort.test.js | 639 | 12 | Food product search — AbortController + 10s timeout | feature |
| food.stale-badge.test.js | 224 | 4 | Food section-header stale badge | feature |
| food.toolbar-row.test.js | 174 | 8 | Food day-nav toolbar row (Round-2 Task 6, defect #9) | feature |
| food.upload-photo.test.js | 300 | 4 | uploadFoodPhoto + Undo (friendly food-photo flow, Task 4) | feature |
| health.design-parity.test.js | 189 | 8 | Health design parity — Round 2 (Task 5) | feature |
| health.dexie-hydration.test.js | 339 | 10 | Health cold-start Dexie hydration (Task 4) | feature |
| health.modal.test.js | 292 | 14 | Edit-note modal (Phase 8, Task 8) | feature |
| health.notes.test.js | 606 | 21 | Health Notes render (Phase 8, Task 7) | feature |
| health.sleep.test.js | 180 | 10 | Health sleep card (Phase 8, Task 4) | feature |
| health.steps.test.js | 129 | 7 | Health steps card (Phase 8, Task 5) | feature |
| health.subtabs.test.js | 139 | 9 | Health sub-tab strip (Phase 8, Task 2) | feature |
| health.summary.test.js | 285 | 23 | Health summary-tile row + range selector (Phase 8, Task 3) | feature |
| health.vitals.test.js | 241 | 18 | Health vitals cards (Phase 8, Task 6) | feature |
| meds.design-parity.test.js | 118 | 8 | Meds design parity (Round 2, Task 4) | feature |
| meds.history.test.js | 287 | 9 | features/meds.js renderHistory (Phase 5, Task 5) | feature |
| meds.inventory.test.js | 286 | 8 | Meds inventory sub-tab (Phase 5, Task 6) | feature |
| meds.modal.test.js | 314 | 17 | EditMedicationModal (Phase 5, Task 7) | feature |
| meds.next-intake.test.js | 155 | 5 | Meds → History next-intake pane (Round-2 Task 8) | feature |
| meds.offline-cold-start.test.js | 260 | 4 | Meds cold-start offline resilience (Task 3) | feature |
| meds.schedule-add.test.js | 127 | 5 | Meds — Add CTA scoped to Schedule subtab (Round-2 Task 7) | feature |
| meds.schedule.test.js | 296 | 6 | Meds schedule sub-tab (Phase 5, Task 4) | feature |
| meds.subtabs.test.js | 166 | 11 | Meds sub-tab strip (Phase 5, Task 2) | feature |
| offline-read-fallbacks.test.js | 235 | 11 | Offline read fallbacks | feature |
| offline-ui.test.js | 341 | 14 | Offline UI indicators | feature |
| push.unit.test.js | 209 | 11 | push.js PushManager | feature |
| safe-confirm.test.js | 141 | 8 | safeConfirm — browser mode (no Telegram context) | feature |
| sections.stale-badge.test.js | 397 | 10 | Section-header stale badges (Task 6) | feature |
| settings.design-parity.test.js | 108 | 5 | Settings design parity — round 2 (Task 7: external-link rows) | feature |
| settings.dexie-hydration.test.js | 331 | 8 | Settings cold-start Dexie hydration (Task 6) | feature |
| settings.food-targets.test.js | 368 | 17 | Settings Food Targets section (Phase 9, Task 6) | feature |
| settings.refresh-on-mount.test.js | 448 | 9 | Settings on-mount refresh (Task 7) | feature |
| settings.render.test.js | 383 | 26 | WGSettings.section | feature |
| settings.sync-timezone.test.js | 264 | 11 | Settings sync + timezone cards (Phase 9, Task 3) | feature |
| settings.toggles.test.js | 380 | 16 | Settings Features section (Phase 9, Task 5) | feature |
| settings.version.test.js | 86 | 5 | Settings version footer (Phase 9, Task 7) | feature |
| settings.webpush.test.js | 269 | 11 | Settings Notifications section (Phase 9, Task 4) | feature |
| settings.weight-unit-toggle.test.js | 487 | 15 | Settings weight-unit segmented control (Task 7) | feature |
| sync.factory.test.js | 443 | 16 | defineOfflineEntity factory | feature |
| sync.manager-flow.test.js | 191 | 6 | sync.js manager flow coverage | feature |
| sync.offline-api.test.js | 306 | 13 | sync.js offlineAwareApiCall behavior | feature |
| sync.offline-read.test.js | 132 | 6 | sync.js offline-read handlers (factory-backed) | feature |
| sync.retry.test.js | 236 | 8 | SyncManager exponential backoff retry | feature |
| sync.unit.test.js | 196 | 7 | sync.js SyncManager unit tests | feature |
| today.aggregate.test.js | 365 | 16 | TodayDashboard.aggregateToday | feature |
| today.card-width.test.js | 136 | 2 | Round-2 defect #1 — Today  | feature |
| today.next-intake-cached.test.js | 131 | 4 | Today next_intake offline read | feature |
| today.next-intake-meds-fallback.test.js | 322 | 9 | Today next-intake meds fallback | feature |
| today.render.test.js | 448 | 25 | TodayDashboard.renderToday | feature |
| today.render.wg.test.js | 197 | 8 | Today render — Task 3 canonical structure | feature |
| today.shortcut-photo-meal.test.js | 129 | 6 | Today shortcut row — Photo meal tile | feature |
| today.stale-badge.test.js | 168 | 5 | Today section-header stale badge | feature |
| today.subscribe.test.js | 179 | 11 | TodayDashboard.subscribe | feature |
| weight.design-parity.test.js | 298 | 20 | Weight design parity — Round 2, Task 1 | feature |
| weight.dexie-hydration.test.js | 230 | 6 | Weight cold-start Dexie hydration (Task 2) | feature |
| weight.history.test.js | 333 | 16 | renderWeightLogs (Phase 6, Task 5) | feature |
| weight.modal.test.js | 546 | 24 | Edit-weight modal (Phase 6, Task 6) | feature |
| weight.range.test.js | 263 | 17 | Weight range selector + chart panel (Phase 6, Task 4) | feature |
| weight.unit-display.test.js | 329 | 18 | formatWeight() helper | feature |
| weight.unit-preference.test.js | 217 | 9 | weight modal: unit-preference inference (Task 4) | feature |
| workout.crud.test.js | 234 | 6 | workout.js CRUD flows | feature |
| workout.design-parity.test.js | 254 | 11 | Workouts round-2 design parity | feature |
| workout.dexie-hydration.test.js | 379 | 12 | Workouts cold-start Dexie hydration (Task 3) | feature |
| workout.edit-variant-exercises.test.js | 175 | 5 | Workouts → Edit Variant exercise rows (Round-2 Task 11) | feature |
| workout.exercises.test.js | 344 | 19 | Workouts exercises library (Phase 7, Task 6) | feature |
| workout.groups.test.js | 274 | 15 | Workouts groups (Phase 7, Task 5) | feature |
| workout.history.test.js | 251 | 10 | Workouts history (Phase 7, Task 4) | feature |
| workout.invalidation.test.js | 241 | 5 | workout invalidation: tag + legacy cache + push-modal flows | feature |
| workout.loaders-and-card.test.js | 170 | 5 | workout.js loaders and next-card behavior | feature |
| workout.modal.test.js | 386 | 21 | Log-set modal shell (Phase 7, Task 8) | feature |
| workout.next-card.test.js | 292 | 9 | Workouts → Next workout card (Round-2 Task 10) | feature |
| workout.session-and-stats.test.js | 508 | 10 | workout.js session and stats flows | feature |
| workout.session-detail.test.js | 234 | 10 | Workouts session detail (Phase 7, Task 4) | feature |
| workout.stats.test.js | 252 | 14 | Workouts Stats sub-tab (Phase 7, Task 7) | feature |
| workout.subtabs.test.js | 167 | 10 | Workouts sub-tab strip (Phase 7, Task 2) | feature |
| workout.today.test.js | 283 | 15 | Workouts today card (Phase 7, Task 3) | feature |
| bootstrap.dynamic-tab.test.js | 83 | 2 | bootstrap.js dynamic tab selection | infra |
| bootstrap.medications.test.js | 130 | 3 | applyBootstrapPayload — medications cache + Dexie seeding | infra |
| bootstrap.today-default.test.js | 123 | 4 | bootstrap.js initial-section restore | infra |
| bootstrap.tz-prompt-nonblocking.test.js | 322 | 6 | bootstrap.js TZ prompt is non-blocking | infra |
| cached-fetch.abort.test.js | 185 | 6 | cachedFetch — timeoutMs propagation | infra |
| cached-fetch.registry.test.js | 195 | 5 | cachedFetch + CacheKeys registry | infra |
| cached-fetch.unit.test.js | 388 | 14 | cachedFetch — read-through helper | infra |
| data-store.hydrate.test.js | 208 | 10 | DataStore.hydrateFromDexie | infra |
| data-store.maintenance.test.js | 103 | 5 | data-store.js maintenance and auth probes | infra |
| data-store.realtime.test.js | 116 | 4 | data-store.js realtime and polling | infra |
| data-store.tag-family.test.js | 234 | 7 | data-store.js tag-family invalidation | infra |
| data-store.unit.test.js | 370 | 14 | data-store.js unit tests | infra |
| db.migration-v6.test.js | 147 | 5 | db.js v5 → v6 schema migration | infra |
| db.sync-duplicate.test.js | 136 | 4 | db.js sync replay — ConstraintError isolation | infra |
| db.unit.test.js | 282 | 8 | db.js store behavior | infra |
| sw-action-queue.test.js | 831 | 22 | SwActionQueue store (db.js) | infra |
| sw-api-helper.test.js | 163 | 10 | sw-api-helper — swApiCall | infra |
| sw-bootstrap-abort.test.js | 206 | 3 | sw.js — /api/bootstrap revalidation timeout (Task 4) | infra |
| sw-handlers.test.js | 395 | 17 | sw.js — notification-action handlers (Task 3) | infra |
| sw-registration-and-fetch.test.js | 398 | 10 | PWA Registration and App Shell behavior | infra |
| app.tab-order.test.js | 81 | 2 | app.tab-order tests | obsolete-candidate |
| app.tab-single-source.test.js | 133 | 7 | Top-level view switching | obsolete-candidate |
| modals.task4b.test.js | 143 | 11 | BP modal — Task 4b audit | obsolete-candidate |
| today.render.task3.test.js | 127 | 4 | Today DOM — Task 3 mockup alignment | obsolete-candidate |
| weight.latest-pane-removed.test.js | 124 | 7 | Weight — Latest pane removed + +Log in toolbar (Round-2 Task 12, #15) | obsolete-candidate |

## Candidate audit against keep-rules

For each prune candidate the inventory records: (a) the assertion shape (top
describe text + count of `it()`s), (b) the sibling test(s) that already cover the
externally-observable behavior, and (c) full-vs-partial duplication. Full = delete
straight; partial = migrate the unique assertion into the sibling first.

### Task 2 — consolidate `modals.*.header-actions.test.js` (11 files → 1)

All 11 files are structurally identical: 4–6 `it()` blocks asserting Cancel/Save
inside `.wg-<modal>__header-actions`, that the legacy `.actions` body row is gone,
that the button ids resolve, and that Cancel sits left of Save. Variant flags
confirmed by `grep`:

| File | it() | Has close-X assertion | Has `form=` assertion |
|------|------|-----------------------|-----------------------|
| modals.bp.header-actions.test.js | 6 | yes | yes (`bp-form`) |
| modals.food.header-actions.test.js | 5 | yes | no |
| modals.meds.header-actions.test.js | 5 | yes | no |
| modals.note.header-actions.test.js | 6 | yes | yes (`note-form`) |
| modals.weight.header-actions.test.js | 6 | yes | yes (`weight-form`) |
| modals.workouts-exercise.header-actions.test.js | 5 | yes | no |
| modals.workouts-group.header-actions.test.js | 5 | yes | no |
| modals.workouts-library.header-actions.test.js | 5 | yes | no |
| modals.workouts-log-set.header-actions.test.js | 5 | yes | no |
| modals.workouts-start.header-actions.test.js | 6 | no | no |
| modals.workouts-variant.header-actions.test.js | 5 | yes | no |

Note: the plan body says only bp + weight + note had close-X assertions and that
only bp + workouts-log-set carried `formAttr`. The audit corrects both — 10 of 11
files have a close-X assertion (workouts-start is the only exception), and the
`form=` assertion belongs to bp / note / weight (not workouts-log-set). The
parameterized suite must therefore take:
- `formAttr` row data on bp / note / weight only
- `closeBtnId` row data on every modal **except** workouts-start
- a single `describe.each` row per modal with conditional `it` execution via
  `if (row.formAttr) it(...)` etc. (matching the plan's "guarded inside the
  assertion" wording).

**Verdict:** consolidate; no migrate-then-delete since the new file owns every
assertion.

### Task 3 — delete pin-removed-feature / task-stamp tests (5 files)

| File | it() | Sibling(s) covering same behavior | Verdict |
|------|------|-----------------------------------|---------|
| weight.latest-pane-removed.test.js | 7 | `weight.history.test.js` (renders #weight-view without the legacy pane); `architecture.toolbar-btn.test.js` (asserts shared toolbar class on `#add-weight-btn`); `app.visual-and-scanner.test.js` (covers `renderWeightRangeSelector` toolbar emission) | partial — 2 assertions touch HTML/CSS removal (`index.html no longer declares the Latest pane`, `styles.css no longer declares any Latest-pane rules`) that no sibling covers. Either migrate as architecture-style guard assertions into `weight.history.test.js` or accept the small coverage loss because the production code path is gone and the assertions are pure regression pins. Recommend: drop, since the asserted strings (`weight-current-card`, `wg-weight-header-row`, `renderWeightCurrentCard`) cannot reappear without a sibling weight test going red. |
| today.render.task3.test.js | 4 | `today.render.test.js` (asserts shortcut row buttons + metric grid + meds card position) and `today.render.wg.test.js` (asserts canonical structure incl. shortcut-tile SVG icons). | full duplication — drop. |
| modals.task4b.test.js | 11 | New `modals.header-actions.test.js` (Cancel-Save layout); `meds.modal.test.js` (modal structure, eyebrow, mono title); `bp.design-parity.test.js` (bp modal layout). | partial — assertions about the take-meds confirm row (`unchecking a row drops the --on modifier`, time-edit toggle) are only in this file. Audit `app.med-confirm-edit-modes.test.js` before deletion: it covers the edit-mode behavior at the integration level, so the `--on` toggle and time-edit assertions are duplicated. Verdict: drop after a final sanity grep in Task 3. |
| app.tab-order.test.js | 2 | `architecture.globals.test.js` (saveTabOrder export); `components.wg-bottom-nav.test.js` (renders ordering); `bootstrap.dynamic-tab.test.js` (tab cache rehydration). | partial — `fetchSettingsBundle preserves cached tabOrder when /api/settings omits it` is unique. Migrate that single assertion into `features.tab-controller.test.js` (or `settings.refresh-on-mount.test.js`) before deletion. |
| app.tab-single-source.test.js | 7 | `components.wg-bottom-nav.test.js` (one `.wg-nav-item--active`); `architecture.globals.test.js` (switchTab export); `bootstrap.dynamic-tab.test.js` (`mt-active-tab` persistence); `features.tab-controller.test.js` (sub-tab loader invocation). | full — every assertion has a sibling. Drop. |

### Task 4 — delete coverage-driven `*branches*` / `*edges*` / `*characterization*` (11 files)

| File | it() | Sibling(s) | Verdict |
|------|------|------------|---------|
| app.behavior-extended.test.js | 6 | `features.*` (back-button, push-modal, medication-utils), `core.app-kernel.test.js`, `data-store.unit.test.js` | full — coverage-only. |
| app.bp-weight-data-and-export-branches.test.js | 5 | `bp.render.test.js`, `bp.history.test.js`, `bp.list-refresh.test.js`, `bp.delete-refresh.test.js`, `weight.history.test.js`, `weight.modal.test.js` (CSV export covered indirectly via `sync.factory` + design-parity export rows). | partial — CSV export branch is only in this file. Migrate one happy-path + one error-path assertion into `bp.history.test.js` / `weight.history.test.js` before deletion. |
| app.loadmeds-bp-swipe-edges.test.js | 2 | `meds.subtabs.test.js`, `bp.render.test.js`, `meds.schedule.test.js` | full — covered. |
| app.med-modal-and-history-branches.test.js | 7 | `meds.modal.test.js`, `meds.history.test.js`, `app.medication-history.test.js` (will be removed in Task 5), `app.med-confirm-edit-modes.test.js`. | full — assertions hit the same selectors/handlers as the feature suites. |
| app.push-actions-and-modal-history-branches.test.js | 3 | `push.unit.test.js`, `features.push-modal.test.js`, `settings.webpush.test.js`, `meds.history.test.js`. | full. |
| app.ui-characterization.test.js | 7 | `bootstrap.dynamic-tab.test.js`, `today.subscribe.test.js`, `features.tab-controller.test.js`, per-feature suites. | full — characterizes internal `switchTab` paths now owned elsewhere. |
| workout.ui-characterization.test.js | 3 | `workout.crud.test.js`, `workout.subtabs.test.js`, `features.tab-controller.test.js`. | full. |
| workout.branch-guards-and-errors.test.js | 4 | `workout.crud.test.js`, `workout.session-and-stats.test.js`, `workout.modal.test.js`, `workout.invalidation.test.js`. | full. |
| workout.swr-and-modal-edges.test.js | 5 | `workout.history.test.js`, `workout.exercises.test.js`, `workout.groups.test.js`, `workout.next-card.test.js`, `workout.session-detail.test.js`. | full. |
| sync.fallback-branches.test.js | 5 | `sync.manager-flow.test.js`, `sync.offline-api.test.js`, `sync.offline-read.test.js`, `sync.factory.test.js`, `offline-read-fallbacks.test.js`. | partial — the `reverse-proxy 5xx as network failure` assertion is unique here; **migrate into `sync.offline-api.test.js`** before deletion (matches the plan's "5xx-as-offline" technical decision). |
| sync.misc.test.js | 2 | `sw-action-queue.test.js` (background-sync registration), `offline-ui.test.js` (toast helper). | full. |

### Task 5 — delete legacy `app.*` form/push/modal suites (5 files)

| File | it() | Sibling(s) | Verdict |
|------|------|------------|---------|
| app.modal-history.test.js | 6 | `meds.history.test.js`, `meds.modal.test.js`, `features.back-button.test.js` (modal stack via back-button). | full. |
| app.medication-history.test.js | 9 | `meds.history.test.js`, `meds.modal.test.js`, `app.log-past-history.test.js`, `app.med-confirm-edit-modes.test.js`. | full — every assertion has a feature peer. |
| app.forms-and-push.test.js | 14 | `push.unit.test.js`, `settings.webpush.test.js`, `features.push-modal.test.js`, `meds.modal.test.js`, `bp.render.test.js`, `weight.modal.test.js`. | partial — one form-submit error-toast assertion is only here; **migrate into the owning feature `*.modal.test.js`** before deletion. Confirm during Task 5 by re-reading the file's `it()` titles. |
| app.gestures-and-notifications.test.js | 1 | `features.back-button.test.js`, `push.unit.test.js`. | full — single assertion duplicated. |
| app.deeplinks-and-push.test.js | 12 | `bootstrap.dynamic-tab.test.js`, `bootstrap.today-default.test.js`, `features.back-button.test.js`, `push.unit.test.js`. | partial — the path-deeplink branches that resolve `?tab=...` / `?action=...` are unique here; **migrate one happy-path assertion into `bootstrap.dynamic-tab.test.js`** before deletion. |

## Final delete list (Tasks 2–5)

**Delete straight (no migration needed) — 26 files:**

- modals.bp.header-actions.test.js
- modals.food.header-actions.test.js
- modals.meds.header-actions.test.js
- modals.note.header-actions.test.js
- modals.weight.header-actions.test.js
- modals.workouts-exercise.header-actions.test.js
- modals.workouts-group.header-actions.test.js
- modals.workouts-library.header-actions.test.js
- modals.workouts-log-set.header-actions.test.js
- modals.workouts-start.header-actions.test.js
- modals.workouts-variant.header-actions.test.js
- today.render.task3.test.js
- modals.task4b.test.js
- app.tab-single-source.test.js
- app.behavior-extended.test.js
- app.loadmeds-bp-swipe-edges.test.js
- app.med-modal-and-history-branches.test.js
- app.push-actions-and-modal-history-branches.test.js
- app.ui-characterization.test.js
- workout.ui-characterization.test.js
- workout.branch-guards-and-errors.test.js
- workout.swr-and-modal-edges.test.js
- sync.misc.test.js
- app.modal-history.test.js
- app.medication-history.test.js
- app.gestures-and-notifications.test.js

**Migrate-then-delete — 6 files (single-assertion migration each):**

- weight.latest-pane-removed.test.js → optional, see Task 3 note
- app.tab-order.test.js → migrate `fetchSettingsBundle tabOrder cache` into a tab/settings sibling
- app.bp-weight-data-and-export-branches.test.js → migrate CSV-export branch into bp/weight history tests
- sync.fallback-branches.test.js → migrate 5xx-as-offline assertion into `sync.offline-api.test.js`
- app.forms-and-push.test.js → migrate form-submit error-toast assertion into owning `*.modal.test.js`
- app.deeplinks-and-push.test.js → migrate path-deeplink happy-path assertion into `bootstrap.dynamic-tab.test.js`

**New file — 1:**

- modals.header-actions.test.js (parameterized `describe.each`)

## Counts confirmation

- Delete count: 11 + 5 + 11 + 5 = **32** files removed
- New file: **1** added
- Net delta: **−31** → 219 − 31 = **188** test files post-prune
- Plan target range 145–160 is **not met** by enumerated candidates (see Gap from
  target above); decision is to accept 188 and record in Task 7's PR description
  rather than expand the deletion list.

