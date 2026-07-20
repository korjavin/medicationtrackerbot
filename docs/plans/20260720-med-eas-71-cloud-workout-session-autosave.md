# med-eas.71 — Cloud workout session modal (ongoing): autosave + Add Exercise reposition + no-Delete-for-in_progress

## Overview

Fix a cluster of UX problems in the cloud web workout **session-detail modal** (the ongoing/in_progress case), all in the shared `web/static` frontend that serves cloud mode:

1. Rename the "Log set" button to **"Add Exercise"** and move it out of the bottom actions bar to a reachable spot near the **top of the logs section**, so you can add an exercise without scrolling past every logged set. The click handler (`onLogSet` → `showAddExerciseToSessionModal`) is unchanged.
2. **Debounced (~800ms) autosave**: any set/reps/weight/rpe edit, add/remove set, status change, notes edit, and after adding an exercise persists through the **existing** `saveWorkoutSessionDetails` path. Save is **decoupled from close** — autosave must NOT close the modal.
3. **Remove the "Save progress" button** entirely. Relabel the existing "Cancel" button to **"Close"**; on close, **flush any pending debounced autosave first** so nothing is lost.
4. On **autosave failure**: keep the modal open, surface an **inline error**, never drop the user's entered local edits.
5. Hide the **Delete** action when `session.status === 'in_progress'`; keep it for completed/skipped.

**KEEP** (flag in PR for owner confirmation): the **"Finish workout"** button (completion is a distinct deliberate action; the owner objected to "Save", not "Finish") and the **status select**.

## Context (from discovery)

Files/components involved (frontend-only, cloud web; do NOT touch bot-mode Go):
- `web/static/js/features/workout/sessions.js` — session modal renderer + edit handlers + `saveWorkoutSessionDetails` + `closeWorkoutSessionModal` + `renderSessionDetailActions` + `showWorkoutSessionModal`.
- `web/static/js/features/workout/index.js` — `bindClick` wiring at lines 140-142 (`workout-session-delete-btn`, `workout-session-cancel-btn`, `workout-session-save-btn`).
- `web/static/index.html` — session modal template at lines ~1512-1538 (header buttons Delete/Cancel/Save + `#workout-session-info` / `#workout-session-logs` / `#workout-session-actions`).
- `web/static/css/styles.css` — `.wg-workouts-session-*` classes (session actions ~7881, header buttons ~7948).
- `web/static/js/tests/features.workout-sessions.test.js` + `web/static/js/tests/workout.session-detail.test.js` — the owning integration suites (extend these; harness `tests/helpers/frontend-harness.js`).

Key facts discovered:
- `saveWorkoutSessionDetails()` (sessions.js ~737) currently reads `workout-session-save-btn` / `workout-session-finish-btn` for busy-state feedback and calls `closeWorkoutSessionModal()` + `loadWorkoutHistoryTab()` on success. It reuses `apiCall` + `DataStore.applyOptimistic` — this is the write path to reuse; do NOT rewrite it.
- Edit handlers already set dirty flags: `updateLocalSet` / `addLocalSet` / `removeLocalSet` (sets `_dirty`/`_setsDirty`), `updateLocalLog` (notes). The status `<select id="session-status-select">` in `renderWorkoutSessionInfo` currently has NO change listener.
- The "Log set" button is rendered in `renderSessionDetailActions` (sessions.js ~703, id `workout-session-add-exercise-btn`, text `'Log set'`) inside `#workout-session-actions`, alongside `finishBtn`. Both carry `.workout-action-btn` so `sync.js` toggles them offline.
- The Delete button is **static in index.html** (`workout-session-delete-btn`), always present; gate it in `showWorkoutSessionModal` by session status using the `.hidden` class (defined in styles.css ~1225), NOT inline `.style`.
- `showAddExerciseToSessionModal` already opens the add-exercise flow (it is `onLogSet`); `saveNewSessionExercise` already persists the new log via its own `logs/create` POST and re-opens the modal — so "after adding an exercise" is already persisted, but an autosave trigger there is harmless and covers status/other pending state.

Related patterns: no existing `debounce` helper in the codebase — add a small closure-local one in sessions.js (no new `window.*` global). Optimistic writes route through `DataStore.applyOptimistic` (CLAUDE.md rule 9) — already handled inside `saveWorkoutSessionDetails`; reuse as-is.

## Development Approach

- **Testing approach**: Regular (code first, then extend the existing integration suites). Repo is **integration-first** via `tests/helpers/frontend-harness.js` — extend the owning workout session/detail `describe` blocks. Do NOT add `*-branches` / `*-edges` / `pin-defect` / `task-N` files (CLAUDE.md rule 8).
- No new `window.*` globals (CLAUDE.md rule 4). The debounce helper + pending-flush live as closure/module-local state in sessions.js.
- No hardcoded colors / inline `.style.` (CLAUDE.md rule 3) — reuse `wg-workouts-*` / `wg-*` classes; add a CSS class if repositioning needs one.
- Reuse the existing `saveWorkoutSessionDetails` write path; do NOT introduce a parallel write pattern.
- Complete each task fully (green vitest) before the next.

## Testing Strategy

- **Unit/integration tests**: extend `web/static/js/tests/features.workout-sessions.test.js` and/or `web/static/js/tests/workout.session-detail.test.js` through the frontend harness. Cover: rename+reposition, autosave-on-edit persists (debounced, timers faked via `vi.useFakeTimers`), save-no-longer-closes, close-flushes-pending, autosave-failure keeps modal open + preserves logs + shows error, delete-hidden-for-in_progress (and visible for completed).
- **Architecture suites** must stay green: `tests/architecture.design-tokens.test.js`, cloud-tokens, `tests/architecture.globals.test.js`.
- Run with **Node 20** (`export PATH="/tmp/node-v20.18.1-linux-x64/bin:$PATH"`; `node -v` must be v20 — Node 18 silently fails vitest).

## Progress Tracking

- Mark completed items `[x]` immediately.
- Add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix.

## Implementation Steps

### Task 1: Reposition + rename "Add Exercise" to top of logs section
- [ ] In `web/static/index.html`, add a logs-section header element above `#workout-session-logs` (e.g. `<div id="workout-session-logs-header" class="wg-workouts-session-logs-header"></div>`) to host the Add Exercise button (a stable node, since `#workout-session-logs` is fully `replaceChildren`'d on every re-render).
- [ ] In `sessions.js` `showWorkoutSessionModal`, render the "Add Exercise" button into `#workout-session-logs-header` wired to `showAddExerciseToSessionModal` (reuse the existing `onLogSet` handler); keep the `.workout-action-btn` hook so sync.js offline toggling still applies, and apply static offline-disabled state as `renderSessionDetailActions` does.
- [ ] In `sessions.js` `renderSessionDetailActions`, remove the "Log set" button (`logSetBtn`) from the bottom actions bar so only "Finish workout" remains there; keep the `onLogSet` param wiring intact or drop it if fully unused (keep signature stable for tests — verify existing callers/tests).
- [ ] In `web/static/css/styles.css`, add a `.wg-workouts-session-logs-header` class (layout only, tokens/`--wg-*` spacing — no hardcoded colors) positioning the button near the top of the logs section.
- [ ] Extend the session-detail integration suite: assert an "Add Exercise" button exists near the top of the logs section (not in the bottom actions bar), and that clicking it opens the add-exercise-to-session modal.
- [ ] Run `npx vitest run` on the workout session/detail suites (Node 20) — must pass before Task 2.

### Task 2: Debounced autosave decoupled from close
- [ ] Add a closure/module-local debounce (~800ms) in `sessions.js`: `scheduleAutosave()` (arms/re-arms a timer that calls the autosave), plus `flushPendingAutosave()` (cancels the timer and awaits an immediate save if one is pending) and a cancel used on modal close/reopen.
- [ ] Refactor `saveWorkoutSessionDetails` to accept an option (e.g. `{ closeOnSuccess = true }` or `fromAutosave` flag) so an autosave-triggered save does **NOT** call `closeWorkoutSessionModal()`; the "Finish workout" path keeps `closeOnSuccess = true`. Do not change the reused apiCall/optimistic write logic.
- [ ] Rework the busy-state/feedback so it no longer depends on the (removed) `workout-session-save-btn`: on Finish, use the finish button for feedback as today; on autosave, do NOT hijack the Finish button text — drive a small inline autosave status/error element instead (see Task 4).
- [ ] Call `scheduleAutosave()` from every edit trigger: `updateLocalSet`, `addLocalSet`, `removeLocalSet`, `updateLocalLog` (notes), the status `<select>` change (add a `change` listener in `renderWorkoutSessionInfo`), and after `saveNewSessionExercise` adds an exercise.
- [ ] Extend the integration suite: editing a set/reps/weight/notes and advancing fake timers ~800ms fires exactly one autosave (batched) that persists via the existing apiCall path and does NOT close the modal; changing the status select autosaves.
- [ ] Run `npx vitest run` on the workout suites (Node 20) — must pass before Task 3.

### Task 3: Remove Save button, relabel Cancel→Close, flush on close
- [ ] In `web/static/index.html`, remove the `workout-session-save-btn` button; change the `workout-session-cancel-btn` label from "Cancel" to "Close".
- [ ] In `web/static/js/features/workout/index.js`, remove the `bindClick('workout-session-save-btn', ...)` line (leave delete + cancel/close bindings).
- [ ] Make `closeWorkoutSessionModal` (and the overlay-click + Close button paths) **flush any pending debounced autosave** before dismissing, so no edits are lost. Ensure the success path of `saveWorkoutSessionDetails` (Finish) doesn't re-enter a flush loop (no pending timer after a completed save).
- [ ] Update any test that referenced the Save button DOM node — update those to the new close/autosave behavior within the owning suite (`WorkoutSessions.save` may stay pointing at `saveWorkoutSessionDetails`).
- [ ] Extend the integration suite: no `workout-session-save-btn` in the DOM; the Close button reads "Close"; closing with a pending debounced edit flushes it (the save fires and the edit is persisted, not dropped).
- [ ] Run `npx vitest run` on the workout suites (Node 20) — must pass before Task 4.

### Task 4: Autosave failure handling (inline error, preserve edits) + hide Delete for in_progress
- [ ] Add an inline error/status element in the session modal (reuse an existing `wg-*` message/error class if one exists; otherwise add a `.wg-workouts-session-autosave-status` class in styles.css — no hardcoded colors). On autosave failure, populate it and keep the modal open; clear it on the next successful autosave.
- [ ] Ensure autosave failure does NOT clear/replace `window.WorkoutSessionsState.logs` (local edits stay intact) and does NOT close the modal — reuse the existing rollback-of-optimistic-cache in `saveWorkoutSessionDetails` (that rolls back the DataStore projection, not the local logs array).
- [ ] In `showWorkoutSessionModal`, toggle the static `workout-session-delete-btn` via the `.hidden` class based on `session.status === 'in_progress'` (hidden for in_progress; shown for completed/skipped). No inline `.style`.
- [ ] Extend the integration suite: an autosave whose apiCall returns null/throws keeps the modal open, keeps the edited logs in state, and shows the inline error; a subsequent successful autosave clears it. Add: in_progress session renders no visible Delete; completed/skipped renders Delete.
- [ ] Run `npx vitest run` on the workout suites (Node 20) — must pass before Task 5.

### Task 5: Verify acceptance criteria
- [ ] Verify all Overview requirements: Add Exercise renamed + repositioned to top + still opens add-exercise modal; edits autosave (debounced) without closing; no Save button; Close flushes pending autosave without losing edits; autosave failure keeps modal open + data intact + error shown; in_progress shows no Delete.
- [ ] Confirm no new `window.*` globals introduced (`tests/architecture.globals.test.js` green).
- [ ] Confirm no hardcoded colors / inline `.style.` (architecture design-tokens + cloud-tokens suites green).
- [ ] Run the full frontend suite `npx vitest run` (Node 20) — all green.

## Technical Details

- Debounce: single module-local timer + a "pending" marker. `scheduleAutosave()` clears+resets the timer to ~800ms; `flushPendingAutosave()` clears the timer and, if pending, `await saveWorkoutSessionDetails({ fromAutosave: true })`. Reset/cancel the timer on modal open and on `closeWorkoutSessionModal`.
- `saveWorkoutSessionDetails({ closeOnSuccess })`: only the terminal `closeWorkoutSessionModal(); loadWorkoutHistoryTab();` block is gated by `closeOnSuccess`. Everything else (validation, optimistic projection, per-log writes, status write, invalidation) is unchanged. Finish path passes `closeOnSuccess: true` (default); autosave passes `false`.
- Feedback element: on autosave, do not mutate the Finish button. Use the inline status element for "Saving…"/error. Concurrency: if an autosave is already in-flight when a new one is scheduled, either coalesce (re-arm timer) or guard with a simple in-flight flag so overlapping saves don't interleave — keep it minimal.

## Post-Completion

**Manual verification** (owner, dogfooding the cloud web session modal for an ongoing workout):
- Add Exercise button is reachable at the top without scrolling past logs.
- Typing sets/reps/weight autosaves within ~1s without closing; closing right after a change loses nothing.
- Killing the network mid-edit surfaces the inline error and keeps the entered data.
- An in_progress session shows no Delete; a completed/skipped one still does.

**Owner confirmation to flag in PR**: "Finish workout" button and the status select are intentionally KEPT (only "Save progress" was removed).
