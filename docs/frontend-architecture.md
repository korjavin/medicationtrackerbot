# Frontend Architecture

This document describes the current frontend architecture for the Telegram WebApp and tracks the incremental refactor path from `frontendplan.markdown`.

## Scope

Primary frontend files:

- `web/static/index.html`
- `web/static/js/app.js`
- `web/static/js/workout.js`
- `web/static/js/data-store.js`
- `web/static/js/db.js`
- `web/static/js/sync.js`
- `web/static/js/push.js`

Test suite:

- `web/static/js/tests/**/*.test.js`
- `web/static/js/tests/helpers/*.js`

## Runtime Structure

### Load Order

`index.html` loads scripts in this order:

1. `db.js`
2. `sync.js`
3. `data-store.js`
4. `app.js`
5. `workout.js`
6. `push.js`

`app.js` now requires `window.DataStore` to be present and throws early if it is not.

### Data Layer

`data-store.js` is the single source of truth for cache/SWR/change-stream behavior.

Responsibilities:

- cache get/set/clear against `MedTrackerDB.ApiCache`
- SWR orchestration (`loadSWR`)
- tag invalidation (`invalidateTags`, `invalidateByTag`)
- changes polling/streaming and auth-expiry handling
- cache maintenance (stale prune)

`app.js` and `workout.js` consume `window.DataStore` and no longer carry duplicate DataStore fallback logic.

### UI Layer

The UI is still vanilla JS with global functions, but key duplicated patterns were centralized:

- `formatDateTimeLocalForInput` for `datetime-local` values
- `downloadBlobAsFile` for CSV export downloads
- generic tab helpers: `activateTabGroup`, `bindTabGroup`
- centralized modal orchestration in `ModalManager`

## Modal Architecture

`ModalManager` in `app.js` is the central modal control point.

Implemented APIs include:

- generic: `open(id)`, `close(id)`
- typed: `bp`, `weight`, `food`, `foodProduct`, `med`, `medConfirm`, `workoutStart`
- registry: `getTopModalDefs()`, `getSubModalDefs()`, `getClosePriorityModalDefs()`
- close policy: `closeTopMostVisibleModal()`

### Back/History Contract

`initModalHistory` delegates close ordering to `ModalManager.closeTopMostVisibleModal()`.

Behavior:

- sub-modals are closed before parent modals
- overlay + `history.pushState` are synchronized
- Telegram BackButton and browser `popstate` share the same close path

This removes modal close-order duplication from history handlers.

## Tab Architecture

Shared tab controller helpers now power all tab groups:

- main tabs (`.tab`)
- medication subtabs (`.med-tab`)
- workout subtabs (`.workout-tab`)

Inline `onclick` handlers for these tab buttons were removed in `index.html`; click delegation is now bound in JS using `bindTabGroup`.

## Testing Architecture

Frontend tests run with Vitest in Node/jsdom:

- command: `pnpm test`
- environment: `node` + jsdom harnesses

Coverage focus:

- UI characterization (tabs/modals)
- modal history/back behavior
- DataStore SWR/invalidation/realtime paths
- API branch behavior and edge cases
- workout flows and modal branches

The suite currently acts as the refactor safety net for incremental changes.

## Refactor Status (Plan Mapping)

From `frontendplan.markdown`:

- Stage 1 (test baseline): completed
- Stage 2 (dedup/helpers): completed for DataStore fallback removal + core shared helpers
- Stage 3 (modal infrastructure): in progress with `ModalManager` now owning close registries and back-close priority
- Stage 4 (tabs abstraction): in progress with shared tab controller applied to main/med/workout groups

Stages 5-7 remain future work (Web Components, safer rendering migration, full cleanup/docs finalization).

## Next Incremental Targets

1. Continue reducing inline handlers outside tabs (modal open/close and action buttons).
2. Move additional modal groups (workout CRUD modals) behind typed `ModalManager` APIs where safe.
3. Start introducing `mt-modal`/`mt-setting-toggle` in one narrow production slice with adapter shims.
4. Reduce `innerHTML` in high-risk sections with user-provided text paths.
