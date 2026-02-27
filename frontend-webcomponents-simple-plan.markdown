# Frontend Simplification Plan: Reusable HTML5 Web Components

## 1) Context and Current Snapshot (based on current code)

What is already done:
- `mt-modal` and `mt-setting-toggle` are already used in production markup.
- No inline DOM handlers in `index.html` (onclick/onchange/etc.).
- Good regression safety net exists (`web/static/js/tests`: 36 files, ~197 tests).

What is still complex:
- `web/static/js/app.js`: 6509 lines, 165 functions.
- `web/static/js/workout.js`: 2199 lines, 58 functions.
- Tab logic duplicated across 3 flows (`switchTab`, `switchMedTab`, `switchWorkoutTab` + `activateTabGroup/bindTabGroup`).
- Day-of-week selector duplicated in meds and workouts (`.days-select` + separate handlers).
- `ModalManager` still contains many manual wrappers while there are 14 `<mt-modal>` nodes.
- UI styling logic is still heavily mixed into JS:
  - `.style.*` writes: app.js = 97, workout.js = 227.
  - inline `style=""` in `index.html`: 48.

## 2) Target: “few reusable components, simple frontend”

Keep architecture intentionally small:

1. `mt-modal` (existing, improved)
- single modal primitive for all dialogs
- handles open/close, backdrop, escape, inert/focus behavior

2. `mt-tab-group` (new)
- one component for main tabs + med sub-tabs + workout sub-tabs
- emits one event (`tabchange`) with active tab id

3. `mt-day-picker` (new)
- reusable day-of-week picker for medication and workout schedules
- exposes value as `[0..6]`

4. `mt-setting-toggle` (existing)
- keep as unified setting row/toggle primitive

5. `mt-card` (new, lightweight shell)
- reusable visual container for list cards and small status blocks
- content via slots (title/body/actions), no business logic inside

Everything else stays plain JS feature controllers (no framework).

## 3) Proposed File Shape (minimal)

- `web/static/js/components/mt-modal.js`
- `web/static/js/components/mt-tab-group.js`
- `web/static/js/components/mt-day-picker.js`
- `web/static/js/components/mt-setting-toggle.js`
- `web/static/js/components/mt-card.js`
- `web/static/js/components/register-components.js`
- `web/static/js/features/` (existing logic split gradually; no big-bang)

Load order principle:
- `register-components.js` before `app.js`/`workout.js`, so custom elements are available.

## 4) Migration Stages

## Stage A: Component baseline extraction (no behavior change)
Tasks:
- [x] Move current `MTModal` and `MTSettingToggle` classes out of `app.js` into `components/`.
- [x] Add `register-components.js`.
- [x] Keep current public API intact (`ModalManager` still works).

Done when:
- [x] behavior unchanged;
- [x] tests pass unchanged.

## Stage B: Tabs -> `mt-tab-group`
Tasks:
- Replace current tab wrappers in `index.html` with `mt-tab-group` (main/med/workout).
- Keep current handlers as adapters first: `tabchange -> existing switch*`.
- Remove `activateTabGroup` and `bindTabGroup` after migration.

Done when:
- one tab component drives all three tab groups;
- no duplicated tab plumbing functions remain.

## Stage C: Days selector -> `mt-day-picker`
Tasks:
- Replace both `.days-select` blocks with `mt-day-picker`.
- Replace `toggleDay` and `toggleWorkoutDay` with component value reads/writes.

Done when:
- one day-picker component is reused in meds and workouts;
- duplicated day-toggle logic removed.

## Stage D: Modal simplification around `mt-modal`
Tasks:
- Move overlay/escape/backdrop behavior into `mt-modal` (or a tiny `ModalStack` helper next to it).
- Reduce `ModalManager` to generic open/close + close-top-most policy.
- Remove one-off wrappers that only proxy by id.

Done when:
- modal lifecycle comes mostly from component contract, not ad-hoc code;
- modal tests cover close order, overlay click, back/popstate interaction.

## Stage E: Visual shell reuse via `mt-card`
Tasks:
- Introduce `mt-card` for common card containers in meds/workouts/history sections.
- Move repeated inline style blocks to CSS classes.
- Keep rendering logic in JS, but reduce style mutation in JS.

Done when:
- `.style.*` writes reduced significantly in workout and app renderers;
- card layout consistency comes from component + CSS, not per-function inline styles.

## Stage F: Optional cleanup pass (if needed)
Tasks:
- Split `app.js` into feature files without changing behavior (`features/meds.js`, `features/bp.js`, etc.).
- Keep one bootstrap entry that wires feature loaders to component events.

Done when:
- clearer file boundaries;
- easier onboarding and maintenance.

## 5) Success Metrics (practical)

Target after Stage E:
- `app.js` <= 3500 lines.
- `workout.js` <= 1400 lines.
- `.style.*` writes in JS reduced by at least 60%.
- tab/day selector duplication removed entirely.
- modal wrappers reduced to a small generic API.
- all current frontend tests green.

## 6) Risks and Guardrails

Key risks:
- breaking Telegram-specific BackButton/popstate behavior.
- regressions in nested modal flows (food scanner/product, workout session/add-exercise).
- subtle UX changes due to focus/inert/backdrop handling.

Guardrails:
- migrate only one UI primitive per stage.
- keep adapter layer for one stage before removing old helpers.
- add/extend characterization tests before removing legacy paths.

## 7) Recommended Implementation Order (short)

1. Stage A (easy win, low risk).
2. Stage B (highest duplication reduction).
3. Stage C (small, high reuse).
4. Stage D (moderate risk, high simplification payoff).
5. Stage E (progressive visual cleanup).
6. Stage F only if code size still blocks maintenance.
