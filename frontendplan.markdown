# Frontend Refactor Plan (Vanilla JS + Web Components)

## 1. Goal
Make the frontend more idiomatic and maintainable without functional regressions:
- reduce duplication in UI/JS;
- move repeated UI patterns into reusable Web Components (Custom Elements);
- evolve toward a more testable structure (unit + DOM + smoke e2e);
- preserve current Telegram WebApp UX, offline/sync behavior, and feature toggles.

## 2. Current State (updated: 2026-02-28)

### 2.1 Key Files
- `web/static/index.html` (921 lines) - main UI skeleton; inline handlers removed, event control moved to JS.
- `web/static/js/app.js` (6406 lines) - main app module (auth/API/state/render/charts/gestures); still the biggest hotspot by size and mixed responsibilities.
- `web/static/js/workout.js` (2199 lines) - workout UI/CRUD/history/stats; string-template hotspot closed, rendering and bindings migrated to DOM/event listeners.
- `web/static/js/data-store.js` - main SWR/cache/changes polling+stream layer.
- `web/static/js/db.js`, `sync.js`, `push.js` - offline/storage/sync/push.
- `web/static/css/styles.css` (1792 lines) - shared styling.

### 2.2 Quick Technical Debt Metrics
- Inline DOM handlers in `index.html` (`onclick`, `onchange`, `onsubmit`, `oninput`, `onfocus`, `onmouseover`, `onmouseout`): `0`.
- `innerHTML` assignments:
  - `app.js`: `31`
  - `workout.js`: `0`
- Inline `onclick` inside JS template strings:
  - `app.js`: `0`
  - `workout.js`: `0`
- Test coverage surface: `35` test files, `193` test cases (Vitest/JSDOM).

### 2.3 Main Problems
1. `app.js` remains monolithic:
   - transport/state/render/event wiring are mixed in one file;
   - feature boundaries are still blurry.
2. `app.js` still has meaningful renderer hotspots:
   - `innerHTML` remains in critical food/health/meds branches;
   - further decomposition into DOM helpers is possible.
3. `workout.js` is still large:
   - transport/state/render/event wiring are mixed;
   - major renderer hotspots are closed, but the file is still big.
4. Stage 6 is close to completion:
   - workout hotspot and inline handlers in `index.html` are closed;
   - remaining work is focused cleanup of `app.js` renderer sections.

### 2.4 What Works Well and Must Not Break
- Telegram WebApp integration (initData, BackButton, alerts/confirms).
- Offline/Sync layer (Dexie + SyncManager + DataStore changes).
- Feature toggles (show/hide tabs and sections).
- Background/service worker behavior.

### 2.5 Stage Progress
- Stage 0: `completed` (baseline scenarios captured, characterization tests in place).
- Stage 1: `completed` (`vitest` + `jsdom`, Telegram/Web API mocks, stable regression runs).
- Stage 2: `completed` (DataStore fallback removed, shared helper utilities extracted).
- Stage 3: `completed` (unified ModalManager + shared modal-history contract).
- Stage 4: `completed` (shared tab-controller + binding for main/med/workout tabs).
- Stage 5: `completed` (`mt-modal` and `mt-setting-toggle` integrated into production markup).
- Stage 6: `in_progress` (workout hotspot and inline handlers in `index.html` closed; focus shifted to remaining `app.js` renderer hotspots).
- Stage 7: `pending`.

## 3. Migration Constraints and Principles
- No big-bang rewrite.
- Every iteration must be small and reversible.
- Test harness/characterization first, code movement second.
- Keep vanilla JS (no React/Vue/Svelte).
- Introduce Web Components gradually, compatible with the current DOM.

## 4. Target Architecture (Incremental)

### 4.1 JS Layers
- `core/`:
  - `api-client.js` (single HTTP wrapper),
  - `state.js` (global state/flags),
  - `date-utils.js`, `dom-utils.js`, `formatters.js`.
- `features/`:
  - `bp/`, `weight/`, `food/`, `meds/`, `workouts/`, `settings/`, `health/`.
- `components/`:
  - Web Components + small reusable renderer helpers.

### 4.2 First Component Candidates
1. `mt-tab-group` - active tab management and `tabchange` event.
2. `mt-modal` - shared shell, overlay, close semantics, escape/back hooks.
3. `mt-setting-toggle` - setting card + toggle + description.
4. `mt-day-picker` - day-of-week selection (med/workout).

## 5. Work Stages

## Stage 0. Baseline Behavior Capture (before refactor)
**Goal:** document current behavior invariants and risks.

Tasks:
- Capture critical user scenarios list (see Section 7).
- Add `frontend-testing-notes.md` (manual smoke checklists before/after).
- Prepare dependency map `index.html -> global JS functions`.

Definition of done:
- explicit behavior baseline exists for comparison after each stage.

## Stage 1. Test Harness
**Goal:** establish test infrastructure for safe migration.

Tasks:
- Set up Node test stack (recommended: `vitest` + `jsdom`).
- Configure unit/DOM tests to run without Telegram browser context.
- Prepare mocks:
  - `window.Telegram.WebApp`,
  - `fetch`,
  - `navigator.serviceWorker`,
  - `window.MedTrackerDB`.
- Add initial characterization tests:
  - main/med/workout tab switching,
  - open/close of key modals,
  - feature toggle visibility,
  - base `apiCall`/`apiCallDirect` behavior on errors.

Definition of done:
- tests run locally with a command like `npm test`;
- minimal green regression suite exists before structural changes.

## Stage 2. Remove Explicit Duplication and Extract Utilities
**Goal:** remove duplication without changing external behavior.

Tasks:
- Remove/simplify `ensureDataStoreAvailable` fallback from `app.js`, keeping `data-store.js` as the single source of truth.
- Extract repeated helpers:
  - local datetime for `datetime-local`,
  - shared CSV download helper,
  - base modal open/close helper.
- Add unit tests for extracted helpers.

Definition of done:
- DataStore duplication removed;
- unit tests cover new helper utilities.

## Stage 3. Modal Infrastructure Decomposition
**Goal:** one modal mechanism, minimal copy-paste.

Tasks:
- Introduce shared `ModalManager` (with or without a lightweight Web Component adapter at first).
- Migrate 2-3 typical modals (BP, Weight, Food) to it.
- Remove duplication in `show*/close*` where possible.
- Add DOM tests for:
  - open/close,
  - overlay behavior,
  - back button/popstate contract.

Definition of done:
- modals operate via one API;
- behavior matches baseline.

## Stage 4. Tabs Abstraction
**Goal:** unify tab switching logic.

Tasks:
- Extract generic tab-controller (`activateTab`, `bindTabGroup`).
- Migrate main tabs + med/workout subtabs.
- Gradually remove inline `onclick` from tab controls.
- Add tests for switch events and loader function calls.

Definition of done:
- 3 separate switch functions consolidated into one mechanism.

## Stage 5. First Set of Web Components
**Goal:** establish component approach without rewriting the whole UI.

Tasks:
- Implement `mt-modal` and `mt-setting-toggle`.
- Integrate into Settings + 1-2 modals.
- Ensure backward compatibility (temporary adapters for current global handlers).
- Cover components with DOM tests (attributes, events, re-render).

Definition of done:
- components are used in production markup;
- reduced inline handlers in touched sections.

## Stage 6. Safer Rendering and Lower `innerHTML` Usage
**Goal:** improve rendering reliability and predictability.

Tasks:
- In critical sections, replace string concatenation templates with:
  - `createElement`/`append`, or
  - safe template helper.
- Priority: sections with user-provided text and frequent edits.
- Add tests for rendering edge cases (empty/null/special chars).

Definition of done:
- significant `innerHTML` reduction in hotspot sections;
- no rendering regressions.

## Stage 7. Finalization and Cleanup
**Goal:** solidify structure and simplify future maintenance.

Tasks:
- Update frontend dev docs (`docs/frontend-architecture.md`).
- Remove obsolete adapters/unused helpers.
- Verify size/performance and load behavior.
- Run final smoke + regression.

Definition of done:
- clear structure,
- tests cover critical surface,
- technical debt in hotspot areas is significantly reduced.

## 6. Risks and Mitigation
1. **Breaking Telegram-specific UX** (BackButton/popstate/alerts)
   - mitigation: mandatory regression tests + manual smoke in Telegram WebApp.
2. **Breaking offline/sync semantics**
   - mitigation: avoid touching sync logic in early stages; change only surrounding interfaces.
3. **Accumulating transitional double-layer code**
   - mitigation: every temporary adapter must have a planned removal in the next concrete stage.
4. **Fragile tests due to DOM details**
   - mitigation: focus on behavior/event assertions, not pixel-level details.

## 7. Minimal Regression Scenario Set
1. App open and initial tab.
2. Main tab switching.
3. Meds/workouts subtab switching.
4. Open/close modals: BP, Weight, Food, Med.
5. Save BP/Weight (mock API success/fail).
6. Feature toggles in Settings and tab visibility reaction.
7. Push confirm modal open/confirm/snooze close.
8. Back gesture/popstate behavior with open modals.
9. Offline GET/POST path via `apiCall` (network error/mock).
10. Data refresh trigger via `requestTabRefresh`.

## 8. What We Do Next (Current Focus)
Next target: **finish Stage 6 in `app.js` and prepare Stage 7**.

Priority backlog:
1. Close remaining renderer hotspots in `app.js`:
   - `renderHealthOverviewContent` (string rendering via `innerHTML +=`);
   - `renderWeeklyHub` (large string renderer);
   - empty/error placeholders in BP/Weight/Food/Health.
2. Complete modal a11y semantics:
   - remove warnings about `aria-hidden` on focused elements;
   - preserve correct `BackButton`/`popstate` behavior.
3. Lock PWA update semantics with tests:
   - fast local startup (cached app shell);
   - background shell refresh;
   - new release visibility (commit hash in Settings).
4. After closing the items above, move to Stage 7:
   - update `docs/frontend-architecture.md`;
   - cleanup temporary adapters and obsolete helper branches.

Stage 6 completion criteria:
- `workout.js` remains without `innerHTML`;
- `app.js` is materially reduced in risky string-render sections (target guidance: `innerHTML` <= 15);
- regression suite remains green (`pnpm test`);
- manual Telegram WebApp smoke has no new modal warnings.

## 9. Parallel Work Plan (Multiple Agents/Branches)
Below is the split into mostly independent tracks with minimal overlap.

| Track | Branch | Allowed Files | Code Zone | Outcome |
|---|---|---|---|---|
| A: Health renderer | `codex/frontend-track-a-health-dom` | `web/static/js/app.js`, `web/static/js/tests/app.visual-and-scanner.test.js` | `app.js` ~5855-5920 | DOM rendering for health overview without `innerHTML +=` |
| B: Weekly hub renderer | `codex/frontend-track-b-weekly-hub-dom` | `web/static/js/app.js`, `web/static/js/tests/app.medication-history.test.js` (or a new test file) | `app.js` ~3853-3969 | DOM/fragment rendering for weekly hub without string template |
| C: Error/empty states | `codex/frontend-track-c-empty-error-ui` | `web/static/js/app.js`, focused tests `app.bp-weight-*`, `app.food-*`, `app.visual-*` | `app.js` ~2381-2409, ~4053-4134, ~5244-5296, ~5918-5920 | unified DOM messages for loading/error/empty states |
| D: Form reset/select cleanup | `codex/frontend-track-d-form-reset-dom` | `web/static/js/app.js`, `web/static/js/tests/app.med-modal-*`, `web/static/js/tests/app.food-products.test.js` | `app.js` ~1901-1970, ~2921-3010, ~3596-3615, ~4690-4692, ~5517 | remove remaining `innerHTML` in reset/build branches |
| E: Modal a11y focus | `codex/frontend-track-e-modal-a11y` | `web/static/js/app.js`, `web/static/js/tests/app.unit.test.js`, `web/static/js/tests/app.modal-history.test.js` | `app.js` ~92-125 + modal close path | remove `aria-hidden` warning while preserving modal history contract |
| F: PWA update tests | `codex/frontend-track-f-pwa-regression` | `web/static/index.html`, `web/static/sw.js`, tests (new/existing) | SW install/fetch + registration update-check | test-lock cached-first shell + background refresh behavior |

### 9.1 Rules to Avoid Cross-Agent Conflicts
1. One track = one branch = one focus.
2. No broad refactors/reformatting of `app.js`.
3. Do not touch other track line ranges, even if nearby code looks improvable.
4. Every PR must be atomic and revert-friendly (1-3 commits, each with one verifiable goal).
5. Full `pnpm test` is mandatory before push.

### 9.2 Minimal DoD Per Track
1. Target scenario is covered by a test (new or extended existing).
2. Full regression run is green.
3. No changes outside agreed scope (except narrowly required integration glue).
4. PR description includes:
   - what changed;
   - how it was validated;
   - remaining risks.

### 9.3 Recommended Merge Order to `master`
1. Track E (modal a11y) - removes user-facing warnings and reduces UX regression risk.
2. Track F (PWA regression) - stabilizes deploy/cache behavior.
3. Tracks A and B (largest renderer hotspots).
4. Track C (empty/error state unification).
5. Track D (remaining form/reset/select cleanup).

## 10. Note for the Next Agent
- The baseline is already stable: do not break SWR/offline/Telegram contracts.
- The key objective is not fewer lines, but **fewer risky points and better separation of responsibilities**.
- If touching `app.js`, keep changes local and avoid a whole-file "relocation" style refactor.
