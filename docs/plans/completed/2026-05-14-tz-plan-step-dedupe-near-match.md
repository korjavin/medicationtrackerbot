# TZ Plan-Step Intake Dedupe: Near-Match Window

## Overview

Fix the duplicate-reminder bug observed on 2026-05-14 (Chicago → Berlin transition,
plan #5): two Candecor intakes coexisted in `intake_log` 96 seconds apart, and the
reminder loop sent both for hours. Root cause is documented in the debug session
above; the user picked **Option A**:

> When the medication scheduler materialises a plan-step target, broaden the
> idempotency check from "is there an intake at *exactly* this scheduled_at" to
> "is there a PENDING intake for this medication *within `minInterval`* of this
> step time". If yes, mark the step consumed against that existing intake and do
> NOT create a new one.

This preserves all existing tests (the symmetric "step consumed first" path
already passes); it adds coverage for the "normal intake materialised before
plan approval" path that the prod incident exposed.

## Context (from discovery)

- Bug surface: `internal/scheduler/medication.go:222-266` — plan-step branch
  inside `MedicationChecker.Check`. The current dedup is keyed on exact
  `scheduled_at` (`batchMap[{MedID, ScheduledAt}]`), so a plan step at
  `02:28:24` does not match a normal intake at `02:30:00` for the same dose.
- Engine side: `internal/domain/tzreschedule/engine.go:174-176` anchors steps
  on `lastIntakePerMedication[med.ID]` (actual `taken_at`), so step times
  inherit second-level drift from real-life intake timestamps — exact match is
  fundamentally fragile.
- Existing overlap guard: `internal/domain/medplan/medplan.go:138-150`
  (`ConsumedStepTimeByMed`) suppresses *future normal-schedule TARGETS* that
  have not yet been materialised. It does NOT recall a pending normal intake
  already in `intake_log` — that's the gap.
- Existing helpers (no new store method needed):
  - `internal/store/medication/repo.go:870`
    `GetPendingIntakesForMedication(medID int64) ([]IntakeLog, error)` — exact
    fit for the per-med lookup we need.
  - `internal/domain/tzreschedule/engine.go:301` `NominalIntervalHours(cfg)`
    and `internal/domain/tzreschedule/policy.go:44` `MinDoseInterval(...)`.
- Sibling regression test pattern to follow:
  `internal/scheduler/medication_tz_test.go:450` (the "consumed step suppresses
  overlapping normal doses" case).
- Prod evidence kept short for future debuggers — see the debug session in
  conversation history; plan #5 in the prod DB has `Candecor` step 1 at
  `2026-05-14 02:28:24 UTC` while intake 4579 covered the same dose at
  `02:30:00 UTC`.

## Development Approach

- **Testing approach**: Regular (code + tests written in the same task; tests
  added next to the existing `medication_tz_test.go` cases).
- Complete each task fully before moving to the next.
- Make small, focused changes — this is a targeted fix, not a refactor.
- **CRITICAL: every task MUST include new/updated tests** for code changes.
- **CRITICAL: all tests must pass before starting the next task** — no
  exceptions.
- **CRITICAL: update this plan file when scope changes during implementation**.
- Run `go test ./internal/scheduler/... ./internal/domain/medplan/...` after
  each change; full `go test ./...` before the verify task.
- Maintain backward compatibility — exact-match dedup keeps working unchanged.

## Testing Strategy

- **Unit tests**: required, added to `internal/scheduler/medication_tz_test.go`
  (sibling subtests inside `TestMedicationCheckerTZAware`). The mock store
  already supports the needed helpers via the in-memory repo in
  `internal/scheduler/test_helpers_*.go` — verify when reading; if a method is
  missing, add it.
- **E2E tests**: not applicable — this is a server-side scheduler change with
  no UI surface.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.

## Implementation Steps

### Task 1: Expose `GetPendingIntakesForMedication` on the scheduler store interface

- [x] add `GetPendingIntakesForMedication(medID int64) ([]store.IntakeLog, error)`
      to the `MedicationStore` interface in
      `internal/scheduler/medication.go` (next to the existing
      `GetPendingIntakes`).
- [x] confirm the live store adapter at `internal/scheduler/adapter.go`
      already forwards to `Repo.GetPendingIntakesForMedication`; add the
      pass-through if missing.
- [x] update any test stores / mocks that implement `MedicationStore`
      (`internal/scheduler/medication_bench_test.go` mocks,
      `internal/scheduler/test_helpers*.go`) to satisfy the new method —
      backing the real repo or returning an empty slice as appropriate.
- [x] write/update a tiny test that the adapter forwards correctly (only if
      adapter pass-through was added in this task).
- [x] run `go test ./internal/scheduler/...` — must pass before next task.

### Task 2: Add near-match plan-step dedup in `MedicationChecker.Check`

- [x] inside the plan-step branch at
      `internal/scheduler/medication.go:227-241`, when the exact-match
      `batchMap` lookup misses, perform a per-med fallback:
  1. compute `minInterval` for the med via
     `tzreschedule.MinDoseInterval(tzreschedule.NominalIntervalHours(cfg),
     tzreschedule.NormalizePolicy(med.TZShiftPolicy))`. Reuse the med's parsed
     schedule (`med.ValidSchedule()`); skip the fallback if the schedule is
     unparsable.
  2. call `store.GetPendingIntakesForMedication(med.ID)`.
  3. select the closest pending intake whose
     `|scheduled_at - step.ScheduledAt| <= minInterval` AND that has no
     `taken_at` set (status PENDING is enforced by the query, but be explicit
     about non-terminal). Ties: prefer the one already attached to the user
     (i.e., earliest existing). Additionally skip intakes covered by a
     previously-consumed step (symmetric with medplan's overlap guard) so a
     later step does not get folded into an earlier consumed step's intake.
  4. if a match is found:
     - call `store.MarkStepConsumed(t.StepID, now)` (same as the existing
       exact-match path).
     - log at INFO with `slog.Info("medication scheduler: plan step consumed
       against pre-existing near-match intake", "stepID", t.StepID, "medID",
       med.ID, "stepScheduledAt", t.ScheduledAt, "existingIntakeID", ...,
       "existingScheduledAt", ..., "deltaSeconds", ...)`.
     - `continue` (do NOT add to `groups`, do NOT create a new intake).
  5. if no match is found, fall through to the existing create-new-intake
     path unchanged.
- [x] keep `planMedTriggered[med.ID] = true` semantics intact — the merge
      counts as "one plan step handled for this med this tick".
- [x] keep behaviour identical for the SourceNormalSchedule branch (line 253)
      — the bug is plan-step-specific.
- [x] write tests in `internal/scheduler/medication_tz_test.go`:
  - **subtest A — "approved plan: past step merges into pre-existing normal
    intake"**: seed a med with daily schedule, create a pending intake at
    `02:30 UTC`, create an APPROVED plan with a step at `02:28:24 UTC` for the
    same med, tick the scheduler at `05:27 UTC`. Assert: exactly one
    `intake_log` row for this med remains, the plan step is consumed (no
    pending steps left), and no new intake was created at `02:28:24`.
  - **subtest B — "approved plan: step outside minInterval still creates new
    intake"**: same setup but the step is 18h away from the pending normal
    intake (clearly outside flexible/medium/strict minIntervals for a daily
    med). Assert: a second intake IS created (current behaviour preserved).
  - **subtest C — "approved plan: near-match merge respects per-med
    minInterval policy"**: parameterise tz_shift_policy (`flexible`,
    `medium`) and pick a step delta (15h) that is inside `medium`'s
    minInterval (15.6h) but outside `flexible`'s (14.4h). Assert that the
    medium-policy med merges and the flexible-policy med (different med,
    same scenario) creates a new intake.
- [x] run `go test ./internal/scheduler/...` — all subtests must pass before
      next task.

### Task 3: Forecast parity check (medplan)

- [x] sanity-read `internal/domain/medplan/medplan.go:77-167` (`PlanDoses`) to
      confirm the forecast path does NOT need the same change. Rationale:
      `PlanDoses` is pure and does not create intakes; forecast consumers
      either render plan-step targets or normal targets but never both for the
      same med in a single window (the `pendingByMed[med.ID]` branch at line
      93 already short-circuits the normal branch).
- [x] if a documented invariant is missing, add a 1-2-line comment near
      `pendingByMed[med.ID]` clarifying that the *materialisation*
      deduplication lives in the scheduler — pointer to
      `medication.go:227-241` and this plan.
- [x] no test required if no behaviour change; if a comment is added, that's
      sufficient.
- [x] run `go test ./internal/domain/medplan/...` — must pass.

### Task 4: Verify acceptance criteria

- [x] verify the prod scenario from the debug session is covered by subtest A
      (Candecor, daily 21:30, anchor drift of 96 seconds, plan medium policy,
      eastbound shift). Confirmed at
      `internal/scheduler/medication_tz_test.go:548-636` — Candecor 16mg daily
      02:30, medium policy, Chicago→Berlin, step at 02:28:24 vs intake at
      02:30:00 (96-second drift); asserts one intake row survives, step
      consumed, no row at the step time.
- [x] run full unit test suite: `go test ./...` — all packages OK.
- [x] run linter: `go vet ./...` (clean) and `gofmt -l .` (13 entries; all
      pre-existing on master, none introduced by this branch — verified via
      master-checkout comparison; the only branch-touched file is
      `internal/scheduler/adapter.go` and gofmt's complaint there is in the
      unrelated workout one-liner block).
- [x] confirm no new `slog.Warn`/`Error` logs were introduced in normal
      operation by skimming test logs — only the deliberate INFO line
      "medication scheduler: plan step consumed against pre-existing
      near-match intake" appears on the merge path.
- [x] confirm the plan-step `intake_reminders` table behaviour is unchanged —
      the near-match branch at `internal/scheduler/medication.go:312-327`
      `continue`s before the `CreateIntake` block at line 363, so no new
      `intake_log` row and therefore no new `intake_reminders` row is
      written. The pre-existing intake's existing reminder thread continues
      unchanged.

### Task 5: [Final] Update documentation

- [x] add a short note to `docs/architecture.md` (or wherever tz-transition
      semantics are documented) about the near-match dedup, since this is a
      subtle invariant future readers will want to find.
- [x] no README update needed.

## Technical Details

- **`minInterval` per medication**: derived from schedule type and policy via
  `tzreschedule.MinDoseInterval(NominalIntervalHours(cfg), policy)`. For a
  daily Candecor with `medium` policy, that is `24h * 0.65 = 15.6h`. The
  96-second prod gap is well inside any reasonable choice; the policy keeps
  the window loose enough to absorb anchor drift but tight enough that
  genuinely distinct doses (12h+ apart) are NOT merged.
- **Why we don't update the existing intake's `scheduled_at` to the step
  time**: the existing intake already has live reminders flowing to it
  (callbacks like `confirm_intake:<id>` reference the intake row, not the
  step). Mutating `scheduled_at` is unnecessary noise; absorbing the step
  silently keeps the user's existing reminder thread intact.
- **Multiple pending intakes**: pick the closest within window. In practice
  the regular scheduler creates at most one PENDING intake per med per day
  per slot; the loop is defensive.
- **Concurrency**: `MarkStepConsumed` is idempotent and ticks are
  single-threaded per process; the existing exact-match path already relies
  on this, so we inherit the same guarantees.
- **Edge case — schedule unparsable**: skip the fallback and let the existing
  create-new-intake path run. The med shouldn't have made it into the plan in
  the first place (`stepsForMedication` returns early), so this is purely
  defensive.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes,
informational only.*

**Manual verification on prod after deploy**:
- Watch the next eastbound or westbound transition (real or via the seed
  helper) for the user. Confirm only one intake exists per dose, that
  consumed-step counts match the user-visible reminders, and that no pair of
  `intake_reminders` rows fires within ~2 minutes for the same med.
- Spot-check `tz_transition_steps.consumed_at` for the first transition after
  deploy — every step should have a `consumed_at` if and only if the user
  confirmed/skipped a corresponding `intake_log` row, regardless of whether
  the intake came from the plan or from the pre-existing normal schedule.

**Follow-up (separate fix, out of scope for this plan)**:
- Reminder-loop double-fire on backfilled past-time intakes
  (`internal/scheduler/medication_reminder.go:65-69`): when the scheduler
  creates an intake whose `scheduled_at` is already >1h in the past and
  `snoozed_until` is NULL, the very next reminder-checker tick fires a second
  reminder ~60s after the initial. Once the dedup lands, this becomes less
  visible (only the plan step's own initial reminder + 1-minute re-fire on
  fresh intakes), but it is still a real bug. Fix: set
  `snoozed_until = now + 1h` at intake creation when `scheduled_at < now -
  1h`. Spin up a separate plan when prioritised.
