Frontend test suite moderate prune and consolidation

## Overview

Reduce the 203-file frontend test suite to roughly the 150-file target by (1) consolidating the 11 `modals.*.header-actions.test.js` files into a single parameterized suite, (2) deleting "pin removed feature" tests that no longer protect against regression, (3) deleting coverage-driven `*branches*` / `*edges*` / `*characterization*` tests that duplicate behavior already exercised by higher-level feature/integration tests, and (4) documenting an integration-first testing posture so the suite does not re-bloat. No production code changes; all behavior must remain green under `pnpm test`.

## Context

- Files involved (source of test suite):
  - `web/static/js/tests/` — 203 `*.test.js` files
  - `vitest.config.mjs` — pool, include glob, setup
  - `web/static/js/tests/helpers/` — `frontend-harness.js`, `data-store-harness.js`, etc. (kept untouched)
  - `CLAUDE.md` and `docs/frontend.md` — for posture documentation
- High-value consolidation target: 11 files matching `modals.*.header-actions.test.js` (63–83 lines each, structurally identical: same 4–6 assertions parameterized only by modal id, header-actions class, cancel/save button ids, form attr). Consolidating into one `modals.header-actions.test.js` keeps every assertion intact and drops ~10 files.
- Likely-obsolete pinning tests (each duplicated by its owning feature test or its architecture-test sibling):
  - `weight.latest-pane-removed.test.js` (defect #15 pin — `weight.history.test.js` covers it)
  - `app.tab-single-source.test.js`, `app.tab-order.test.js` (architecture concerns also covered by `architecture.*.test.js` + `components.wg-bottom-nav.test.js`)
  - `today.render.task3.test.js` (a task-N-specific pin; merged into `today.render.test.js` already)
  - `modals.task4b.test.js` (task-specific pin)
- Likely-redundant coverage-driven tests:
  - `app.bp-weight-data-and-export-branches.test.js`, `app.loadmeds-bp-swipe-edges.test.js`, `app.med-modal-and-history-branches.test.js`, `app.push-actions-and-modal-history-branches.test.js`, `app.behavior-extended.test.js`, `workout.branch-guards-and-errors.test.js`, `workout.swr-and-modal-edges.test.js`, `sync.fallback-branches.test.js`, `sync.misc.test.js` — added to lift coverage numbers; their externally-observable assertions overlap their feature-suite siblings (`features.*`, `workout.*`, `sync.manager-flow.test.js`).
  - `app.ui-characterization.test.js`, `workout.ui-characterization.test.js` — characterize internal `switchTab` calls now covered by `bootstrap.dynamic-tab.test.js`, `today.subscribe.test.js`, and per-feature suites.
- Keep (do not touch):
  - `architecture.*.test.js` (11 files — guardrails)
  - `components.wg-*.test.js` (web components have no integration equivalent)
  - `db.*`, `sw-*`, `cached-fetch.*`, `data-store.*`, `bootstrap.*` (cross-cutting infra with no other coverage)
  - All `features.*` and feature-folder `*.modal.test.js` / `*.render.test.js` / `*.history.test.js` (these are the integration-style tests the user prefers).

## Development Approach

- Complete each task fully before moving to the next.
- Removals are decided file-by-file against three criteria: (a) every `it()` assertion in the file is duplicated by another file's assertion; (b) the file pins a behavior that is also pinned by an `architecture.*.test.js`; or (c) the file targets a removed feature with no remaining production code path. If a file fails all three, keep it.
- After each deletion batch run `pnpm test` — the full suite must stay green.
- Testing policy: integration tests ONLY. Do NOT plan for unit tests. This work is test-maintenance, so most tasks have no new test item. The consolidated modal header-actions suite is a refactor of existing assertions, not a new test.

## Implementation Steps

### Task 1: Build a triage inventory

**Files:**
- Create: `docs/plans/notes/frontend-test-inventory.md` (working note, will not be committed long-term — delete on completion of Task 6)

- [x] generate one row per `web/static/js/tests/*.test.js` file with: file name, line count, `it()` count, top-level `describe()` text, and a category label (architecture / component / infra / feature / consolidate-candidate / obsolete-candidate / coverage-candidate)
- [x] for each consolidate/obsolete/coverage candidate, list the sibling file(s) whose assertions overlap, and note whether the assertion is fully duplicated (delete) or partially duplicated (need to migrate one assertion before deleting)
- [x] surface the final delete list (target ~50 files) and the migrate-then-delete list to confirm against the keep-rules above

### Task 2: Consolidate modal header-actions suites

**Files:**
- Create: `web/static/js/tests/modals.header-actions.test.js`
- Delete: `web/static/js/tests/modals.bp.header-actions.test.js`
- Delete: `web/static/js/tests/modals.food.header-actions.test.js`
- Delete: `web/static/js/tests/modals.meds.header-actions.test.js`
- Delete: `web/static/js/tests/modals.note.header-actions.test.js`
- Delete: `web/static/js/tests/modals.weight.header-actions.test.js`
- Delete: `web/static/js/tests/modals.workouts-exercise.header-actions.test.js`
- Delete: `web/static/js/tests/modals.workouts-group.header-actions.test.js`
- Delete: `web/static/js/tests/modals.workouts-library.header-actions.test.js`
- Delete: `web/static/js/tests/modals.workouts-log-set.header-actions.test.js`
- Delete: `web/static/js/tests/modals.workouts-start.header-actions.test.js`
- Delete: `web/static/js/tests/modals.workouts-variant.header-actions.test.js`

- [x] write a single parameterized suite with one `describe.each([...])` block: each row gives `modalSelector`, `headerActionsSelector`, `cancelBtnId`, `saveBtnId`, optional `formAttr` (only bp + workouts-log-set have it), optional `closeBtnSelector` (only bp + weight + note had close-X assertions)
- [x] migrate every distinct `it()` from the 11 files into the parameterized block; assertions present in some files but not others become conditional `it.skipIf(!row.formAttr)` or simply guarded inside the assertion
- [x] delete the 11 source files
- [x] run `pnpm test web/static/js/tests/modals.header-actions.test.js` — must show the same per-modal assertion counts as before consolidation

### Task 3: Delete obsolete pin-removed-feature and task-specific tests

**Files:**
- Delete: `web/static/js/tests/weight.latest-pane-removed.test.js` (covered by `weight.history.test.js`)
- Delete: `web/static/js/tests/today.render.task3.test.js` (assertions merged into `today.render.test.js`)
- Delete: `web/static/js/tests/modals.task4b.test.js` (task-stamp pin with no behavior not pinned by `modals.header-actions.test.js`)
- Delete: `web/static/js/tests/app.tab-order.test.js` and `web/static/js/tests/app.tab-single-source.test.js` (covered by `components.wg-bottom-nav.test.js` + `architecture.globals.test.js`)

- [x] verify each file's assertions are duplicated elsewhere by running `git grep` for the asserted selectors / button ids in the rest of `web/static/js/tests/`
- [x] for any assertion not duplicated, migrate it into the sibling file before deletion; otherwise delete the file
- [x] run `pnpm test` — green

### Task 4: Delete coverage-driven branches/edges/characterization tests

**Files (delete after confirming the file fails all three keep-rules):**
- Delete: `web/static/js/tests/app.bp-weight-data-and-export-branches.test.js`
- Delete: `web/static/js/tests/app.loadmeds-bp-swipe-edges.test.js`
- Delete: `web/static/js/tests/app.med-modal-and-history-branches.test.js`
- Delete: `web/static/js/tests/app.push-actions-and-modal-history-branches.test.js`
- Delete: `web/static/js/tests/app.behavior-extended.test.js`
- Delete: `web/static/js/tests/app.ui-characterization.test.js`
- Delete: `web/static/js/tests/workout.ui-characterization.test.js`
- Delete: `web/static/js/tests/workout.branch-guards-and-errors.test.js`
- Delete: `web/static/js/tests/workout.swr-and-modal-edges.test.js`
- Delete: `web/static/js/tests/sync.fallback-branches.test.js`
- Delete: `web/static/js/tests/sync.misc.test.js`

- [ ] for each file: skim assertions and confirm each is duplicated by a feature test (`features.*`, `workout.*`, `sync.manager-flow`, `sync.retry`, `meds.*`, `bp.*`, `food.*`, `weight.*`, `today.*`). The criterion is the externally-observable behavior, not the spy call counts on internal helpers.
- [ ] where an assertion targets a real user behavior not covered elsewhere (e.g., the offline-fallback render path), migrate that single assertion into the feature suite (e.g., `bp.render.test.js`, `sync.manager-flow.test.js`) before deleting the source file
- [ ] delete files in two batches (app.* first, workout/sync second), running `pnpm test` between batches to catch unexpected dependencies

### Task 5: Trim duplicate app.* form / push / modal suites

**Files (delete only after migrate-then-delete check):**
- Delete: `web/static/js/tests/app.modal-history.test.js` (covered by `meds.history.test.js`)
- Delete: `web/static/js/tests/app.medication-history.test.js` (covered by `meds.history.test.js`)
- Delete: `web/static/js/tests/app.forms-and-push.test.js` (push covered by `push.unit.test.js` + `settings.webpush.test.js`; forms covered by feature `*.modal.test.js`)
- Delete: `web/static/js/tests/app.gestures-and-notifications.test.js` if assertions duplicated by `features.back-button.test.js` + `push.unit.test.js`; otherwise keep and skip
- Delete: `web/static/js/tests/app.deeplinks-and-push.test.js` if assertions duplicated by `bootstrap.dynamic-tab.test.js`; otherwise keep

- [ ] same migrate-then-delete protocol as Task 4: any unique externally-observable assertion is moved into the owning feature suite before the source file is removed
- [ ] run `pnpm test` — green

### Task 6: Document integration-first testing posture

**Files:**
- Modify: `docs/frontend.md` (append a "Testing posture" section near the existing test-related notes)
- Modify: `CLAUDE.md` (one-line pointer to the new section under "Critical Rules" — only if it changes how Claude writes future tests)
- Delete: `docs/plans/notes/frontend-test-inventory.md` (working note from Task 1)

- [ ] write a "Testing posture" section that states: integration tests through `frontend-harness.js` are the preferred level; new pure-unit tests are added only when there is no integration entry point (web components, DB layer, service worker, sync engine); coverage-driven tests are not added; "pin defect #N" tests should be merged into the owning feature suite rather than created as standalone files
- [ ] reference the file-naming conventions that survived the prune: `architecture.*`, `components.wg-*`, `features.*`, `<feature>.<aspect>.test.js`, and the consolidated `modals.header-actions.test.js`
- [ ] remove the working inventory note

### Task 7: Verify acceptance criteria

- [ ] run `pnpm test` — must pass with zero failures and zero unexpected suites being skipped
- [ ] run `go test ./...` — must pass (sanity, in case any architecture test enforces a now-deleted file)
- [ ] confirm final file count: `find web/static/js/tests -name '*.test.js' | wc -l` should be approximately 150 (target range 145–160); record actual count in the PR description
- [ ] confirm no test file imports a now-deleted file (`git grep -l "modals\.bp\.header-actions\|app\.ui-characterization\|weight\.latest-pane-removed" web/static/js/tests/` returns empty)
