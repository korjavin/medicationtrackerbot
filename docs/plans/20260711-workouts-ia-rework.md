# Workouts IA rework — Plan/Day naming, simple-default, one picker (med-prk.3)

## Overview
Implement the agreed Workouts IA redesign from `docs/design/2026-07-11-workouts-ia.md` (med-prk.1, merged #584). Three user-facing changes:
1. **Naming**: "Group" → "Plan", "Variant" → "Day", schedule copy "days of week" → "Repeats on" — **user-facing strings only**, internal ids/data-attrs/table columns unchanged (Vitals-slot precedent: relabel, keep the internal id for deeplink/localStorage stability).
2. **Simple-default create flow**: a new Plan is a single flat exercise list with **no** rotation/Day UI and **no** surfaced phantom "Main" variant. Rotation is an explicit opt-in "Rotate through days" toggle.
3. **One shared add-exercise picker**: unify plan-editing and in-session add-exercise into one path — search the library or create-new (upserts into the library, references it — the med-prk.2 model already supports this).

Both modes share the `web/static` frontend, so this is mode-agnostic; the changes are UI-only and **no `/api` contract change is expected**. If any request/response shape does change, it must land in Go **and** `web/domain/workout.js` together.

## Context (from discovery)
- **Workout UI files**: `web/static/js/features/workout/` — `index.js` (sub-tab routing + tab labels, localStorage key at `index.js:39-41`), `groups.js` (group list + create/edit modal; **the phantom "Main" variant shim at `groups.js:315-343`**, dup in `toggleRotatingFields` `groups.js:369-391`), `variants.js` (variant CRUD, rotation_order field `:110-115`), `exercises.js` (plan-exercise CRUD; `resolveVariantForExercise` `:120-148`; add-modal library `<datalist>` `:172-212`), `library.js` (library catalog), `next-card.js` ("Next Variant" `:355,361`), `sessions.js` (in-session add: `showAddExerciseToSessionModal` `:804`, `saveNewSessionExercise` `:887`, **refusal of non-library names `:911`**), `history.js`, `stats.js`, `modals.js`.
- **Markup/labels**: `web/static/index.html` (tab labels, modal titles, days-of-week schedule UI), `web/static/css/styles.css` (label classes only).
- **User-facing strings today** (from IA map): "Workout Group" / "Add/Edit Workout Group" / "No workout groups yet…" / "Delete this workout group?"; "Rotating" tag (`groups.js:189`); "Add/Edit Variant" / "Variant name is required!" / "No variants yet…" / `name (Order: N)` (`variants.js:49`); subtitle "{variant_name} · {n} exercises" (`next-card.js:313`).
- **Cloud parity**: `web/domain/workout.js` mirrors the group/variant/exercise/library model; the shared-picker create-new path routes through `createExercise` → `promoteExerciseToLibrary` (already reference-aware post med-prk.2).
- **Tests**: workout feature suites via `tests/helpers/frontend-harness.js` (e.g. `web/static/js/tests/workout.edit-variant-exercises.test.js`, `features.workout-*.test.js`); cloud shim contract `web/static/js/tests/cloud.shim-contract.workout-crud.test.js`. Repo-wide guards `tests/architecture.*.test.js`.

## Development Approach
- **Testing approach**: NO unit tests. Add integration coverage only at the two real user-flow boundaries (simple-default create produces no visible Day UI + a working exercise; shared-picker create-new-from-session lands in the library). Extend the owning workout feature suite via `tests/helpers/frontend-harness.js` — do **not** add coverage-driven `-branches`/`-edges`/`pin-defect` files.
- **Naming is relabel-only**: never rename internal ids, `data-tab` values, element ids, localStorage keys, `is_rotating`/`rotation_order`, or DB columns. Grep for the visible string, not the identifier.
- **Frontend rules (CLAUDE.md)**: no hardcoded colors / inline `.style.` (use `--wg-*` tokens + CSS classes — architecture tests enforce); any new `window.*` global needs a `tests/architecture.globals.test.js` allowlist entry; write handlers use `DataStore.applyOptimistic`.
- Complete each task fully (existing tests green) before the next.
- **CRITICAL: if a task adds an integration test, it must pass before the next task.**
- **CRITICAL: update this plan file if scope changes.**

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: two, at real boundaries — (a) simple-default create flow, (b) shared-picker create-new-from-session — in the workout feature suite. No new infrastructure.
- **E2E**: none.

## Progress Tracking
- Mark `[x]` immediately when done. ➕ new tasks, ⚠️ blockers. Keep in sync.

## What Goes Where
- Implementation Steps (`[ ]`) = string relabels, flow changes, the shared picker, two integration tests.
- Post-Completion (no checkboxes) = manual UI walkthrough in both modes, med-prk.3 closure note.

## Implementation Steps

### Task 1: Relabel "Group" → "Plan" (user-facing strings only)
- [ ] tab label "Groups" → "Plans" in `web/static/index.html` and `web/static/js/features/workout/index.js`, **keeping** the internal `data-tab="groups"` value and the localStorage sub-tab key (`index.js:39-41`)
- [ ] modal titles + empty/delete/ fallback copy in `groups.js` ("Add/Edit Workout Group" → "Add/Edit Plan", "No workout groups yet…" → "No plans yet", "Delete this workout group?" → "Delete this plan?", row fallback)
- [ ] any remaining "group" user-facing text in `next-card.js` / `history.js` / `index.html`
- [ ] grep the workout frontend for visible "group"/"Group" strings to confirm none are missed (excluding identifiers/data-attrs/ids)

### Task 2: Relabel "Variant" → "Day" and schedule copy → "Repeats on"
- [ ] `variants.js`: "Add/Edit Variant" → "Add/Edit Day", "Variant name is required!" → "Day name is required", "No variants yet…" → "No days yet", row `name (Order: N)` → day label (keep `rotation_order` internal)
- [ ] `next-card.js`: "Next Variant" button (`:355,361`) → "Next Day"; subtitle "{variant_name} · …" wording as a Day
- [ ] `exercises.js`: any "variant" user-facing text → "Day"
- [ ] schedule UI "days of week" → "Repeats on" in `groups.js` + `index.html` (label/copy only; keep the underlying `days_of_week` field/ids)
- [ ] relabel the `workout-group-rotating` checkbox to "Rotate through days" (keep the element id)

### Task 3: Simple-default create flow (no phantom "Main"/Day UI)
- [ ] a newly created Plan defaults to non-rotating and shows a single flat exercise list with **no** Day/Variant/rotation words; do not surface the auto-created hidden variant name to the user (`groups.js:315-343`, `toggleRotatingFields` `:369-391`, `resolveVariantForExercise` in `exercises.js:120-148`) — keep the one hidden variant server-side (schema unchanged) but suppress its label everywhere in the simple view
- [ ] the "Rotate through days" toggle (Task 2) is the only place Day UI appears; off = flat list, on = reveals the Days editor
- [ ] integration test (real boundary): create a Plan in the default (simple) flow → assert no "Day"/"Variant"/"Main" label is rendered and an exercise can be added and listed (workout feature suite via `frontend-harness.js`)

### Task 4: Rotation off-switch guard
- [ ] in the Plan edit / rotation-toggle path, block turning rotation **off** while the Plan has more than one Day; show a message to delete the extra Days first (zero data loss). Single Day (or simple plan) toggles freely.

### Task 5: One shared add-exercise picker (plan + session)
- [ ] extract a single picker helper used by both the plan-exercise add modal (`exercises.js:172-212`) and the in-session add modal (`sessions.js:804`, `:887`): search the library OR create-new (create-new upserts into the library and references it via the med-prk.2 model)
- [ ] **remove** the in-session refusal of names not already in the library (`sessions.js:911`) — create-new is now allowed and lands in the library
- [ ] keep write handlers on `DataStore.applyOptimistic`; no new `window.*` global unless allowlisted
- [ ] integration test (real boundary): from an in-session add, create a brand-new exercise name → assert it is saved to the session AND appears in the library afterward (feature suite)

### Task 6: Cloud parity check
- [ ] confirm no `/api` request/response shape changed (naming is UI-only); if the shared picker altered any payload, mirror it in `web/domain/workout.js` and update the shim contract test / regen `cmd/genmcpcatalog` + `ResponseExample` if a registry op changed. Run `web/cloud/js/tests/mcp-responder.test.js` and `cloud.shim-contract.workout-crud.test.js`.

### Task 7: Verify acceptance criteria
- [ ] `go build ./...` and `go build -tags mobile ./...`
- [ ] `go test ./...`
- [ ] `pnpm test` — all pass, **including** the repo-wide `tests/architecture.*.test.js` (globals, no-inline-style, no-module-state, native-abstractions, nav) — feature-suite green ≠ CI green
- [ ] no new `window.*` global without a `tests/architecture.globals.test.js` allowlist entry; no hardcoded colors / inline `.style.`
- [ ] verify the Overview requirements: no "Group"/"Variant" user-facing strings remain; simple plan shows no Day UI; shared picker works in both plan and session

### Task 8: [Final] Update docs
- [ ] update `docs/frontend.md` (navigation) and/or `docs/features.md` (workouts) where they name "Group"/"Variant" for the UI, to "Plan"/"Day"
- [ ] note med-prk.3 implements the design doc; leave the internal-id/label split explicit (Vitals-slot precedent)

## Technical Details
- **Relabel discipline**: change only string literals rendered to the user and static HTML text nodes / labels. Leave `id=`, `data-tab=`, `class=`, `name=`, JS variable/field names, `is_rotating`, `rotation_order`, `days_of_week`, and localStorage keys untouched.
- **Hidden variant**: the server still auto-creates one variant per non-rotating plan (unchanged from today / med-prk.2); this task only stops the UI from *labeling* it. "Simple plan" = plan with rotation off; its single variant is an implementation detail.
- **Shared picker**: one helper, two call sites — prefer extraction over duplicating the datalist+create logic in `exercises.js` and `sessions.js`.

## Post-Completion
*No checkboxes — manual/external.*

**Manual verification** (both modes — server bot + cloud):
- Create a simple Plan: confirm no "Group"/"Variant"/"Day"/"Main" wording, add exercises via the picker, it schedules and notifies.
- Enable "Rotate through days": add Day B/C, confirm rotation picks the next Day; try to turn rotation off with >1 Day → blocked with the delete-extra-Days message.
- In a running session, add a brand-new exercise via the picker → it logs and shows up in the Exercises library.

**Issue tracker:**
- On merge, close med-prk.3; epic med-prk fully complete.
