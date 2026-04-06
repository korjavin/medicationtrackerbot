---
# Fix Tab Order Not Persisting Across Refresh

## Overview

The drag-and-drop tab reordering never saves the order because `window.saveTabOrder` is undefined at runtime. The function is defined in `features/settings.js`, which is never loaded in `index.html`. The fix adds `saveTabOrder` directly to `app.js` where it is used, and also ensures tab order is applied from the local cache in the offline/fallback path.

## Context

- Files involved:
  - `web/static/js/app.js` — contains `initTabsDragAndDrop` callback that calls `window.saveTabOrder`
  - `web/static/js/features/settings.js` — defines `window.saveTabOrder` but is not loaded in HTML
  - `web/static/index.html` — script load order; `settings.js` is absent
  - `internal/server/settings_handlers.go` — `handleSetTabOrder`, works correctly
  - `internal/store/store.go` — `SetTabOrder` / `GetTabOrder`, work correctly
- Related patterns: `window.initTabsDragAndDrop` (tabs-dnd.js) already calls `onOrderChange`; `applyTabOrder` is called from `applyBootstrapPayload` in app.js
- Secondary bug: `settings.js:saveTabOrder` calls `window.DataStore.getCache()` but the method is `getCached()` — causes silent cache-update failure (fix while touching the file)

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Minimal change: define `saveTabOrder` in app.js rather than wiring in all of settings.js (which has duplicate event bindings that would conflict)
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Define `saveTabOrder` in `app.js`

**Files:**
- Modify: `web/static/js/app.js`

- [ ] Right before the `initTabsDragAndDrop` call near the bottom of `app.js`, define `window.saveTabOrder` as an async function that:
  1. Validates the order array
  2. POSTs to `/api/settings/tab-order` via `apiCall`
  3. On success, reads the cached `settings_bundle` via `window.DataStore.getCached('settings_bundle')` and updates `tabOrder` in it, then writes it back
- [ ] Write tests for `saveTabOrder` in an appropriate test file (e.g., `app.ui-characterization.test.js` or a new `app.tab-order.test.js`)
- [ ] Run `cd web/static/js/tests && npx vitest run` — must pass before Task 2

### Task 2: Apply tab order from cache on offline/fallback bootstrap

**Files:**
- Modify: `web/static/js/app.js`

- [ ] In the offline fallback branch of `checkAuth` (the `serverUnavailable && cachedAuth` path), after loading medications from cache, also load the `settings_bundle` cache and call `applyTabOrder(bundle.tabOrder)` if present
- [ ] Write a test that verifies tab order is applied from cache in the offline path
- [ ] Run `cd web/static/js/tests && npx vitest run` — must pass before Task 3

### Task 3: Fix `getCache` typo in `features/settings.js`

**Files:**
- Modify: `web/static/js/features/settings.js`

- [ ] Change `window.DataStore.getCache('settings_bundle')` to `window.DataStore.getCached('settings_bundle')` in `saveTabOrder` (even though settings.js is not currently loaded, this prevents a future regression)
- [ ] Run `cd web/static/js/tests && npx vitest run` — must pass before Task 4

### Task 4: Verify acceptance criteria

- [ ] Manual test: drag tab to a new position, refresh page — tab should be in the saved position
- [ ] Run full test suite: `go test ./...` (Go) and `cd web/static/js/tests && npx vitest run` (JS)
- [ ] Run linter if configured

### Task 5: Update documentation

- [ ] Update CLAUDE.md note on Tab Reordering if wording is now inaccurate
- [ ] Move this plan to `docs/plans/completed/`
