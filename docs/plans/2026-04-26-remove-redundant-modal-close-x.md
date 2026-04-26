# Remove Redundant Modal Close-X Button

## Overview

After moving Cancel/Save into the modal header, every form modal now has **two buttons that do the same thing**: a stand-alone close-X icon button on the left of the header, and a textual "Cancel" button on the right of the header. The X is redundant — it duplicates Cancel without adding any affordance the keyboard user or screen reader doesn't already have via Cancel + backdrop tap. Remove the X from all 11 `.wg-modal` form modals to reduce visual noise.

The reference modal (`WorkoutSessionModal`) already follows this — it has Delete/Cancel/Save in the header with no separate X. Bringing the other 11 modals in line restores the design intent shown in the handoff (`.local/medtrackerbot-ref/design_handoff_vitals/screenshots/05-08`), where the title + actions row is the only header element.

## Context (from discovery)

**Per-modal close-X buttons to remove (11 total):**

| # | Modal | Button id | HTML location |
|---|---|---|---|
| 1 | EditFoodModal | `food-modal-close-btn` | `web/static/index.html:949` |
| 2 | TakeMedsModal / med editor | `med-modal-close-btn` | `web/static/index.html:1133` |
| 3 | LogBPModal | `bp-modal-close-btn` | `web/static/index.html:1281` |
| 4 | EditWeightModal | `weight-modal-close-btn` | `web/static/index.html:1366` |
| 5 | EditNoteModal | `note-modal-close-btn` | `web/static/index.html:1420` |
| 6 | Workout Group modal | `workout-group-close-btn` | `web/static/index.html:507` |
| 7 | Workout Variant modal | `workout-variant-close-btn` | `web/static/index.html:605` |
| 8 | Workout Exercise modal | `exercise-close-btn` | `web/static/index.html:666` |
| 9 | Workout Library modal | `exercise-library-close-btn` | `web/static/index.html:740` |
| 10 | Workout LogSet modal | `session-add-exercise-close-btn` | `web/static/index.html:883` |
| 11 | Workout Start modal | (no X — header was rebuilt in last plan) | n/a — confirm only |

**Out of scope:** `MedConfirmModal` (`wg-med-confirm-modal__close-btn` at line 1452 — split-action modal with no Cancel button; X is the only dismiss affordance and must stay), legacy `food-scanner-close-btn` (text "Close" button, not an X), and any non-modal close icons (e.g. Telegram chrome).

**JS handlers / setup to remove or update:**
- `web/static/js/app.js:1446` — `bindClick('med-modal-close-btn', () => closeModal())`
- `web/static/js/app.js:1489` — `bindClick('bp-modal-close-btn', () => closeBPRecordModal())`
- `web/static/js/app.js:1492` — `bindClick('weight-modal-close-btn', () => closeWeightModal())`
- `web/static/js/features/food.js:24` — `closeGloss = querySelector('#food-modal-close-btn .wg-gloss')` (icon hydration)
- `web/static/js/features/food.js:168` — `bindClick('food-modal-close-btn', () => closeFoodModal())`
- `web/static/js/features/bp.js:39` — close-X gloss icon hydration
- `web/static/js/features/weight.js:200` — close-X gloss icon hydration
- `web/static/js/features/health.js:1175,1188` — close-X gloss + bindClick for note-modal
- `web/static/js/features/workout.js:108-131` — `bindClick` for all 5 workout close buttons
- `web/static/js/features/workout.js:160-180` — `renderWorkoutModalCloseIcons()` helper that hydrates the gloss span on all 5 workout close buttons (function should be removed entirely if all 5 close buttons go away)

**CSS to remove:** `.wg-*-modal__close-btn` rules across `web/static/css/styles.css` (one per modal).

**Dismiss affordances that REMAIN after removal:** Cancel button (in header), backdrop tap (handled by `<mt-modal>` core — see `web/static/js/components/mt-modal.js`), Esc key (if implemented).

**Test infra:** Vitest + jsdom. Tests live in `web/static/js/tests/`. Existing per-modal header-actions tests added in the previous plan (e.g. `modals.food.header-actions.test.js`) — extend or add sibling tests asserting the close-X is gone.

## Development Approach

- **Testing approach:** Regular (remove the X, then assert it's gone and Cancel still works).
- One modal per task. Each task: HTML + JS handler removal + CSS cleanup + test update + run `pnpm test`.
- Verify backdrop-tap dismissal still works after removal (covered by existing `core.modal-controller.test.js`; spot-check one modal manually).
- No bot / Go changes expected.

## Testing Strategy

- **Unit / DOM tests** (Vitest + jsdom): for each modal, assert:
  - `document.getElementById('<modal-id>').querySelector('#<modal>-close-btn')` returns `null`.
  - Cancel button still resolves and clicking it dismisses the modal (extend the existing per-modal `header-actions.test.js` or its companion).
- **Architecture tests:** must continue to pass.
- **Manual verification (post-completion):** open each modal in a touch device / mobile emulation, confirm Cancel is the only header dismiss control and backdrop tap still closes.

## Progress Tracking

- Mark `[x]` immediately when each item is done.
- `➕` for newly discovered references (extra event listeners, hidden a11y handling).
- `⚠️` for blockers (e.g. CSS class shared with non-modal element).
- Update plan if a modal has additional close logic (deeplink history, push-action).

## What Goes Where

- **Implementation Steps:** delete HTML in `web/static/index.html`, delete JS bindings/icon hydration in `web/static/js/`, delete CSS in `web/static/css/styles.css`, update tests in `web/static/js/tests/`.
- **Post-Completion:** manual mobile pass to confirm Cancel + backdrop are sufficient dismiss affordances and the header looks balanced (no orphan flex gap).

## Implementation Steps

### Task 1: EditFoodModal — remove close-X
- [x] in `web/static/index.html:942-1048`, delete the `<button id="food-modal-close-btn">` element (and its enclosing wrapper if it leaves an empty container)
- [x] in `web/static/js/features/food.js`, delete the `closeGloss = querySelector('#food-modal-close-btn .wg-gloss')` icon hydration block (line ~24) and the `bindClick('food-modal-close-btn', ...)` call (line ~168)
- [x] in `web/static/css/styles.css`, remove `.wg-food-modal__close-btn` rule(s)
- [x] update `web/static/js/tests/modals.food.header-actions.test.js` to assert `getElementById('food-modal-close-btn')` is `null`; verify Cancel still dismisses
- [x] `pnpm test` — must pass before Task 2

### Task 2: TakeMedsModal / med-modal — remove close-X
- [x] delete `<button id="med-modal-close-btn">` in `web/static/index.html:1129-1274`
- [x] in `web/static/js/app.js:1446`, delete the `bindClick('med-modal-close-btn', () => closeModal())` line
- [x] check for any med-modal close-icon hydration (grep `med-modal-close-btn`); remove if present
- [x] remove `.wg-meds-modal__close-btn` rule(s) from `web/static/css/styles.css`
- [x] update `web/static/js/tests/modals.meds.header-actions.test.js` to assert close-X is gone
- [x] `pnpm test` — must pass before Task 3

### Task 3: LogBPModal — remove close-X
- [x] delete `<button id="bp-modal-close-btn">` in `web/static/index.html:1277-1360`
- [x] in `web/static/js/app.js:1489`, delete the `bindClick('bp-modal-close-btn', ...)` line
- [x] in `web/static/js/features/bp.js:39`, delete the close-gloss icon hydration block
- [x] remove `.wg-bp-modal__close-btn` rule(s) from `web/static/css/styles.css`
- [x] update `web/static/js/tests/modals.bp.header-actions.test.js` to assert close-X is gone
- [x] `pnpm test` — must pass before Task 4

### Task 4: EditWeightModal — remove close-X
- [x] delete `<button id="weight-modal-close-btn">` in `web/static/index.html:1363-1415`
- [x] in `web/static/js/app.js:1492`, delete the `bindClick('weight-modal-close-btn', ...)` line
- [x] in `web/static/js/features/weight.js:200`, delete the close-gloss icon hydration block
- [x] remove `.wg-weight-modal__close-btn` rule(s) from `web/static/css/styles.css`
- [x] update `web/static/js/tests/modals.weight.header-actions.test.js` to assert close-X is gone
- [x] `pnpm test` — must pass before Task 5

### Task 5: EditNoteModal — remove close-X
- [x] delete `<button id="note-modal-close-btn">` in `web/static/index.html:1418-1446`
- [x] in `web/static/js/features/health.js`, delete the close-gloss icon hydration block (line ~1175) and the `getElementById('note-modal-close-btn')` handler block (line ~1188)
- [x] remove `.wg-health-modal__close-btn` (or `.wg-note-modal__close-btn`) rule(s) from `web/static/css/styles.css`
- [x] update `web/static/js/tests/modals.note.header-actions.test.js` to assert close-X is gone
- [x] `pnpm test` — must pass before Task 6

### Task 6: Workout Group modal — remove close-X
- [x] delete `<button id="workout-group-close-btn">` in `web/static/index.html:507`
- [x] in `web/static/js/features/workout.js:108`, delete the `bindClick('workout-group-close-btn', ...)` line
- [x] in `web/static/js/features/workout.js:167`, remove `'workout-group-close-btn'` from the `closeBtnIds` array inside `renderWorkoutModalCloseIcons()`
- [x] remove `.wg-workouts-group-modal__close-btn` rule(s) from `web/static/css/styles.css`
- [x] update `web/static/js/tests/modals.workouts-group.header-actions.test.js`
- [x] `pnpm test` — must pass before Task 7

### Task 7: Workout Variant modal — remove close-X
- [x] delete `<button id="workout-variant-close-btn">` in `web/static/index.html:605`
- [x] in `web/static/js/features/workout.js:114`, delete the `bindClick('workout-variant-close-btn', ...)` line
- [x] in `web/static/js/features/workout.js:168`, remove `'workout-variant-close-btn'` from the `closeBtnIds` array
- [x] remove `.wg-workouts-variant-modal__close-btn` rule(s) from `web/static/css/styles.css`
- [x] update `web/static/js/tests/modals.workouts-variant.header-actions.test.js`
- [x] `pnpm test` — must pass before Task 8

### Task 8: Workout Exercise modal — remove close-X
- [x] delete `<button id="exercise-close-btn">` in `web/static/index.html:666`
- [x] in `web/static/js/features/workout.js:119`, delete the `bindClick('exercise-close-btn', ...)` line
- [x] in `web/static/js/features/workout.js:169`, remove `'exercise-close-btn'` from the `closeBtnIds` array
- [x] remove `.wg-workouts-exercise-modal__close-btn` rule(s) from `web/static/css/styles.css`
- [x] update `web/static/js/tests/modals.workouts-exercise.header-actions.test.js`
- [x] `pnpm test` — must pass before Task 9

### Task 9: Workout Library modal — remove close-X
- [ ] delete `<button id="exercise-library-close-btn">` in `web/static/index.html:740`
- [ ] in `web/static/js/features/workout.js:123`, delete the `bindClick('exercise-library-close-btn', ...)` line
- [ ] in `web/static/js/features/workout.js:170`, remove `'exercise-library-close-btn'` from the `closeBtnIds` array
- [ ] remove `.wg-workouts-library-modal__close-btn` rule(s) from `web/static/css/styles.css`
- [ ] update `web/static/js/tests/modals.workouts-library.header-actions.test.js`
- [ ] `pnpm test` — must pass before Task 10

### Task 10: Workout LogSet modal — remove close-X + drop dead helper
- [ ] delete `<button id="session-add-exercise-close-btn">` in `web/static/index.html:883`
- [ ] in `web/static/js/features/workout.js:131`, delete the `bindClick('session-add-exercise-close-btn', ...)` line
- [ ] in `web/static/js/features/workout.js:171`, remove `'session-add-exercise-close-btn'` from the `closeBtnIds` array
- [ ] verify the `closeBtnIds` array in `renderWorkoutModalCloseIcons()` is now empty — if so, delete the entire `renderWorkoutModalCloseIcons` function and any caller
- [ ] remove `.wg-workouts-log-set-modal__close-btn` rule(s) from `web/static/css/styles.css`
- [ ] update `web/static/js/tests/modals.workouts-log-set.header-actions.test.js` (or `web/static/js/tests/workout.modal.test.js` if the assertion lives there)
- [ ] `pnpm test` — must pass before Task 11

### Task 11: Verify acceptance criteria
- [ ] `grep -nE 'modal-close-btn|workout-group-close-btn|workout-variant-close-btn|exercise-close-btn|exercise-library-close-btn|session-add-exercise-close-btn' web/static/index.html web/static/js web/static/css` — no occurrences in scope (MedConfirmModal `wg-med-confirm-modal__close-btn` is intentionally retained)
- [ ] `grep -n 'wg-.*-modal__close-btn' web/static/css/styles.css` — only the MedConfirm rule remains
- [ ] confirm `Workout Start modal` header has no X (already restructured in prior plan; verify by grepping `workout-start-close-btn` returns nothing)
- [ ] run `pnpm test` — all 1500+ tests pass
- [ ] run `go test ./...` — smoke check
- [ ] confirm backdrop-tap dismiss still works for one representative modal (covered by existing `core.modal-controller.test.js`)

## Technical Details

**Pattern to remove (per modal):**
```html
<!-- before -->
<div class="wg-<name>-modal__header-actions">
  <button id="<name>-modal-close-btn" class="wg-icon-btn …" aria-label="Close"><span class="wg-gloss"></span></button>
  <button id="<name>-modal-cancel-btn" …>Cancel</button>
  <button id="<name>-modal-save-btn" …>Save</button>
</div>

<!-- after -->
<div class="wg-<name>-modal__header-actions">
  <button id="<name>-modal-cancel-btn" …>Cancel</button>
  <button id="<name>-modal-save-btn" …>Save</button>
</div>
```

**JS removal pattern:**
- Delete each `bindClick('<modal>-close-btn', …)` call.
- Delete each `querySelector('#<modal>-close-btn .wg-gloss')` icon-hydration block.
- For workout: shrink the `closeBtnIds` array; delete `renderWorkoutModalCloseIcons()` once empty.

**CSS removal pattern:**
- Delete every `.wg-<name>-modal__close-btn` rule. If the rule is part of a comma-separated selector list with non-close-btn classes, prune just the close-btn entry.

**Dismiss affordances retained:** `[Cancel]` button + `<mt-modal>` backdrop tap. No new code required to preserve them — both are already wired.

## Post-Completion

**Manual verification:**
- Open each refactored modal on touch device / Chrome devtools mobile emulation; confirm dismissal works via Cancel and via backdrop tap, and the header reads as `[Title] [Cancel] [Save]` with no extra slot.
- Visual parity with `.local/medtrackerbot-ref/design_handoff_vitals/screenshots/05-08` (no X icon in any of the modal screenshots).

**External system updates:** none.
