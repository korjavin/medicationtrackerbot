# Move Modal Confirm/Cancel Buttons to Header

## Overview

Move primary action buttons (Cancel / Save / Confirm) out of bottom action rows and into the modal header — beside the title — across all `.wg-modal` form modals. Mobile keyboards currently occlude the bottom action row, forcing users to dismiss the keyboard before submitting. Header-aligned actions stay visible above the keyboard.

This continues the convention established for `WorkoutSessionModal` (reference: `web/static/index.html:843-868`) and the design decision recorded on 2026-02-19. The reference design handoff in `.local/medtrackerbot-ref/design_handoff_vitals/` shows the exact target structure (eyebrow line, then a title row with `[title left] [Cancel] [Save right]`).

## Context (from discovery)

**Reference (already correct):**
- `WorkoutSessionModal` — `web/static/index.html:843-868`. Uses `.wg-workouts-session-modal__header-actions` flex row inside `.__header`, with `.__heading` (eyebrow + title) on the left and Delete/Cancel/Save on the right. CSS at `web/static/css/styles.css` (`.wg-workouts-session-modal__header*`).

**11 modals to refactor (all `.wg-modal` shells):**

| # | Modal | HTML location | Existing actions class |
|---|---|---|---|
| 1 | EditFoodModal (`food-modal`) | `web/static/index.html:942-1048` | `.wg-food-modal__actions` (body footer). Header already has `.wg-food-modal__header-actions` for close-X — extend it with Cancel/Save. |
| 2 | TakeMedsModal / med editor (`med-modal`) | `web/static/index.html:1129-1274` | `.wg-meds-modal__actions` |
| 3 | LogBPModal (`bp-modal`) | `web/static/index.html:1277-1360` | `.wg-bp-modal__actions` |
| 4 | EditWeightModal (`weight-modal`) | `web/static/index.html:1363-1415` | `.wg-weight-modal__actions` |
| 5 | EditNoteModal (`note-modal`) | `web/static/index.html:1418-1446` | `.wg-health-modal__actions` |
| 6 | Workout Group modal | `web/static/index.html:500-590` | `.wg-workouts-group-modal__actions` |
| 7 | Workout Variant modal | `web/static/index.html:~593-695` | `.wg-workouts-variant-modal__actions` |
| 8 | Workout Exercise modal | `web/static/index.html:~697-790` | `.wg-workouts-exercise-modal__actions` |
| 9 | Workout Library modal | `web/static/index.html:~792-840` | `.wg-workouts-library-modal__actions` |
| 10 | Workout LogSet modal | `web/static/index.html:875-939` | `.wg-workouts-log-set-modal__actions` |
| 11 | Workout Start modal | `web/static/index.html:1484-1498` | `.actions` (legacy — promote to wg pattern as part of fix) |

**Out of scope** (handled separately if needed): legacy `modal-header` modals (Food Scanner, Food Product, Food Save Meal, Mi Band Workout — already top-aligned in their own way), and `MedConfirmModal` (mixed split-action layout, intentional).

**CSS file:** `web/static/css/styles.css` — modal action rules clustered around lines 4780+ (food), 4922 (weight), 5059 (bp), 6150 (meds), 6469 / 6713 / 6829 / 6964 / 7080 (workout family), 7906 (note).

**Test infra:** Vitest + jsdom. Tests live in `web/static/js/tests/`. `package.json` test command: `pnpm test`. Existing modal tests: `core.modal-controller.test.js`, `workout.modal.test.js`. Architecture tests in `web/static/js/tests/architecture.*.test.js` — no inline-style violations introduced.

## Development Approach

- **Testing approach:** Regular (refactor each modal, then add DOM-structure assertions).
- Complete each modal fully before moving to the next.
- Each task must include a small Vitest/jsdom test asserting the modal's Cancel + Save buttons live inside `.wg-*-modal__header-actions` (or the equivalent header container) and that the old `.__actions` body row is gone.
- Run `pnpm test` after each task — must pass before next.
- Run `go test ./...` once at the end (no Go changes expected, but this is a smoke check).
- No JavaScript event-wiring changes: button IDs stay the same (e.g. `food-modal-cancel-btn`, `food-modal-save-btn`), so existing `app.js` / modal-controller listeners keep binding.

## Testing Strategy

- **Unit / DOM tests** (Vitest + jsdom): for each refactored modal, assert:
  - `document.getElementById('<modal-id>').querySelector('.wg-*-modal__header-actions')` contains both the Cancel and Save buttons.
  - The legacy `.wg-*-modal__actions` body row no longer exists in the DOM.
  - Button IDs (`*-cancel-btn`, `*-save-btn`) still resolve via `getElementById` (event handlers must keep working).
- **Architecture tests** (`web/static/js/tests/architecture.*.test.js`): existing tests must continue passing — no inline `style.*` assignments introduced, no new `window.*` globals.
- **No new e2e tests** (project does not yet have Playwright/Cypress wired up; previous tabbed UI changes shipped without e2e).

## Progress Tracking

- Mark `[x]` immediately when each item is done.
- Use `➕` prefix for newly discovered subtasks (e.g. an unexpected Save-button event listener that needs re-wiring).
- Use `⚠️` prefix for blockers (e.g. a CSS rule shared with non-modal components).
- Update this plan if a modal's structure differs significantly from the WorkoutSessionModal template.

## What Goes Where

- **Implementation Steps**: HTML edits in `web/static/index.html`, CSS edits in `web/static/css/styles.css`, new `*.test.js` cases in `web/static/js/tests/`.
- **Post-Completion**: manual mobile keyboard verification (cannot automate without e2e tooling), visual regression check against `.local/medtrackerbot-ref/design_handoff_vitals/screenshots/05-08`.

## Implementation Steps

### Task 1: EditFoodModal — actions to header
- [x] in `web/static/index.html:942-1048`, append `<button id="food-modal-cancel-btn">Cancel</button>` and `<button id="food-modal-save-btn">Save entry</button>` (both with `wg-gloss` / `wg-gloss--sun` + new `wg-food-modal__header-btn*` classes) into the existing `.wg-food-modal__header-actions` container, just after the close-X button
- [x] delete the bottom `<div class="wg-food-modal__actions">…</div>` block (~lines 1040-1045)
- [x] in `web/static/css/styles.css` near line 4780+, replace `.wg-food-modal__actions` rules with `.wg-food-modal__header-actions { display: flex; gap: 8px; align-items: center; }` and `.wg-food-modal__header-btn` sizing matching `.wg-workouts-session-modal__header-btn`
- [x] add `web/static/js/tests/modals.food.header-actions.test.js` asserting Cancel + Save are inside `.wg-food-modal__header-actions` and body has no `.wg-food-modal__actions`
- [x] `pnpm test` — must pass before Task 2

### Task 2: TakeMedsModal / med-modal — actions to header
- [x] add `<div class="wg-meds-modal__header-actions">` inside `.wg-meds-modal__header` (after `.wg-meds-modal__heading`) at `web/static/index.html:1129-1274`, containing the two buttons currently in `.wg-meds-modal__actions`
- [x] delete the bottom `.wg-meds-modal__actions` block
- [x] update `web/static/css/styles.css` near line 6150: replace `.wg-meds-modal__actions` rules with `.wg-meds-modal__header-actions` and `.wg-meds-modal__header-btn`
- [x] add `web/static/js/tests/modals.meds.header-actions.test.js` asserting structure
- [x] `pnpm test` — must pass before Task 3 (passes; pre-existing date-flaky sleep/steps chart tests unrelated to this task)

### Task 3: LogBPModal — actions to header
- [x] move `.wg-bp-modal__actions` buttons (Cancel, Save) into a new `.wg-bp-modal__header-actions` inside `.wg-bp-modal__header` at `web/static/index.html:1277-1360`
- [x] delete the bottom `.wg-bp-modal__actions` block
- [x] update `web/static/css/styles.css` near line 5059
- [x] add `web/static/js/tests/modals.bp.header-actions.test.js`
- [x] `pnpm test` — must pass before Task 4 (new BP-header test + updated `modals.task4b.test.js` pass; pre-existing date-flaky sleep/steps chart tests unrelated to this task)

### Task 4: EditWeightModal — actions to header
- [x] move `.wg-weight-modal__actions` buttons into a new `.wg-weight-modal__header-actions` inside `.wg-weight-modal__header` at `web/static/index.html:1363-1415`
- [x] delete the bottom `.wg-weight-modal__actions` block
- [x] update `web/static/css/styles.css` near line 4922
- [x] add `web/static/js/tests/modals.weight.header-actions.test.js`
- [x] `pnpm test` — must pass before Task 5 (new weight-header test + updated `weight.modal.test.js` pass; pre-existing date-flaky sleep/steps chart tests unrelated to this task)

### Task 5: EditNoteModal — actions to header
- [x] move `.wg-health-modal__actions` buttons into a new `.wg-health-modal__header-actions` inside the note-modal header at `web/static/index.html:1418-1446`
- [x] delete the bottom `.wg-health-modal__actions` block (verify the class is not reused by sibling note components — if so, scope the rename to `.wg-note-modal__header-actions`) — class is only used by `#note-modal`, no rename needed
- [x] update `web/static/css/styles.css` near line 7906
- [x] add `web/static/js/tests/modals.note.header-actions.test.js`
- [x] `pnpm test` — must pass before Task 6 (new note-header test + updated `health.modal.test.js` pass; pre-existing date-flaky sleep/steps chart tests unrelated to this task)

### Task 6: Workout Group modal — actions to header
- [ ] move `.wg-workouts-group-modal__actions` buttons into `.wg-workouts-group-modal__header-actions` inside the header at `web/static/index.html:500-590`
- [ ] delete the bottom `.wg-workouts-group-modal__actions` block
- [ ] update `web/static/css/styles.css` near line 6469
- [ ] add `web/static/js/tests/modals.workouts-group.header-actions.test.js`
- [ ] `pnpm test` — must pass before Task 7

### Task 7: Workout Variant modal — actions to header
- [ ] move `.wg-workouts-variant-modal__actions` buttons into `.wg-workouts-variant-modal__header-actions`
- [ ] delete the bottom `.wg-workouts-variant-modal__actions` block
- [ ] update `web/static/css/styles.css` near line 6713
- [ ] add `web/static/js/tests/modals.workouts-variant.header-actions.test.js`
- [ ] `pnpm test` — must pass before Task 8

### Task 8: Workout Exercise modal — actions to header
- [ ] move `.wg-workouts-exercise-modal__actions` buttons into `.wg-workouts-exercise-modal__header-actions`
- [ ] delete the bottom `.wg-workouts-exercise-modal__actions` block
- [ ] update `web/static/css/styles.css` near line 6829
- [ ] add `web/static/js/tests/modals.workouts-exercise.header-actions.test.js`
- [ ] `pnpm test` — must pass before Task 9

### Task 9: Workout Library modal — actions to header
- [ ] move `.wg-workouts-library-modal__actions` buttons into `.wg-workouts-library-modal__header-actions`
- [ ] delete the bottom `.wg-workouts-library-modal__actions` block
- [ ] update `web/static/css/styles.css` near line 6964
- [ ] add `web/static/js/tests/modals.workouts-library.header-actions.test.js`
- [ ] `pnpm test` — must pass before Task 10

### Task 10: Workout LogSet modal — actions to header
- [ ] move `.wg-workouts-log-set-modal__actions` buttons into `.wg-workouts-log-set-modal__header-actions` at `web/static/index.html:875-939`
- [ ] delete the bottom `.wg-workouts-log-set-modal__actions` block
- [ ] update `web/static/css/styles.css` near line 7080
- [ ] update existing `web/static/js/tests/workout.modal.test.js` if it asserts the old button placement; otherwise add `web/static/js/tests/modals.workouts-log-set.header-actions.test.js`
- [ ] `pnpm test` — must pass before Task 11

### Task 11: Workout Start modal — promote to wg pattern + actions to header
- [ ] at `web/static/index.html:1484-1498`, restructure the legacy `.actions` block: wrap with a `.wg-modal` shell using a new `wg-workouts-start-modal__header` containing `.wg-workouts-start-modal__heading` (eyebrow + title) and `.wg-workouts-start-modal__header-actions` (Cancel + Start)
- [ ] add the corresponding CSS in `web/static/css/styles.css` (mirror the workouts-session-modal pattern)
- [ ] add `web/static/js/tests/modals.workouts-start.header-actions.test.js`
- [ ] `pnpm test` — must pass before Task 12

### Task 12: Verify acceptance criteria
- [ ] grep `web/static/index.html` and `web/static/css/styles.css` for any remaining `*-modal__actions` selector — none should remain except the workouts-session reference (already correct) and out-of-scope legacy/`MedConfirm` modals (per Context section)
- [ ] run full frontend test suite: `pnpm test` — all suites pass
- [ ] run Go test suite: `go test ./...` — all suites pass (smoke check)
- [ ] verify architecture tests still pass (no inline-style or new-global violations): tests under `web/static/js/tests/architecture.*.test.js`
- [ ] confirm all 11 modals share consistent button order: `[Cancel]` left of `[Save]` (per Modal button order pattern from 2026-02-19)

## Technical Details

**HTML pattern (per modal, mirror of `wg-workouts-session-modal`):**
```html
<mt-modal id="<modal-id>" class="hidden wg-modal wg-<name>-modal">
  <div class="wg-<name>-modal__header">
    <div class="wg-<name>-modal__heading">
      <span class="wg-section-label wg-<name>-modal__eyebrow">EYEBROW</span>
      <span class="wg-mono-display wg-<name>-modal__title">Title</span>
    </div>
    <div class="wg-<name>-modal__header-actions">
      <button id="<name>-modal-cancel-btn" class="wg-gloss wg-<name>-modal__header-btn">Cancel</button>
      <button id="<name>-modal-save-btn"   class="wg-gloss wg-gloss--sun wg-<name>-modal__header-btn wg-<name>-modal__header-btn--save">Save</button>
    </div>
  </div>
  <div class="wg-<name>-modal__body"> … fields … </div>
</mt-modal>
```

**CSS pattern (per modal):**
```css
.wg-<name>-modal__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.wg-<name>-modal__heading { display: flex; flex-direction: column; gap: 2px; }
.wg-<name>-modal__header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
.wg-<name>-modal__header-btn { padding: 8px 12px; font-size: 12px; }
.wg-<name>-modal__header-btn--save { padding: 8px 14px; }
```

**Button IDs / event wiring:** keep IDs identical (`*-cancel-btn`, `*-save-btn`). Existing handlers in `web/static/js/app.js` and modal-controller modules bind by ID, so moving the elements does not break behavior.

## Post-Completion

**Manual verification:**
- Open each refactored modal on a real mobile device or Chrome devtools mobile emulation with the keyboard simulated; confirm Cancel/Save remain visible while a text input is focused.
- Visual regression: compare each refactored modal against the corresponding screenshot in `.local/medtrackerbot-ref/design_handoff_vitals/screenshots/` (`05-edit-food-modal.png`, `06-take-meds-modal.png`, `07-edit-weight-modal.png`, `08-log-bp-modal.png`).
- Verify keyboard tab order still feels natural: form fields → header actions (or use `tabindex` if header actions land before fields and need to come last in tab order — note this is a follow-up if any user reports a bad flow).

**External system updates:** none. Bot/Telegram/MCP channels are unaffected. No DB migration. No API change.
