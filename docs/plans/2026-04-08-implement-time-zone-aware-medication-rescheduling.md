---
# Implement Time-Zone-Aware Medication Rescheduling

## Overview

Add a per-medication `tz_shift_policy` field (flexible/medium/strict) and a timezone transition planning system. When the user records a new timezone (or a DST offset change is detected), the system generates a safe, idempotent transition plan with explicit dose shift steps anchored to the last actual intake, presents it via Telegram for approval (with risk labels and safety guarantees highlighted), and executes doses from the plan during the transition period. A separate step-tracking table provides auditability and partial-execution recovery. Structured observability logs are emitted at each stage.

## Context

- Files involved:
  - `internal/store/store.go` — Medication struct, new plan/step store methods
  - `internal/store/migrations/` — three new migrations (045, 046, 047)
  - `internal/domain/tzreschedule/` — new package: policy.go, engine.go, planner.go
  - `internal/scheduler/medication.go` — use user TZ + respect active plan
  - `internal/scheduler/tz_plan_notifier.go` — polls for pending plans, sends Telegram message
  - `internal/bot/tz_plan_callbacks.go` — approve/reject/cancel callbacks
  - `internal/bot/bot.go` — add callback routing
  - `internal/scheduler/scheduler.go` — register the new checker in the shared scheduler
  - `internal/server/settings_handlers.go` — trigger plan generation after timezone change
  - `internal/server/medication_handlers.go` and `internal/server/store_interfaces.go` — plumb `tz_shift_policy` through create/update requests and interfaces
  - `web/static/js/app.js` or medication feature file — policy dropdown in form
- Related patterns:
  - Workout/BP schedulers already call `store.GetCurrentTimezone()` — reuse same pattern
  - Domain service pattern from `internal/workout/service.go`
  - JSON golden-file test pattern in `internal/testharness`
- Dependencies: none new

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: DB migrations — policy column, plan table, step table

**Files:**
- Create: `internal/store/migrations/045_add_medication_tz_shift_policy.sql`
- Create: `internal/store/migrations/046_add_tz_transition_plans.sql`
- Create: `internal/store/migrations/047_add_tz_transition_steps.sql`
- Modify: `internal/store/store.go`

- [x] Migration 045: `ALTER TABLE medications ADD COLUMN tz_shift_policy TEXT NOT NULL DEFAULT 'flexible'`
- [x] Migration 046: create `tz_transition_plans` table with columns: `id INTEGER PRIMARY KEY`, `old_tz TEXT`, `new_tz TEXT`, `created_at DATETIME`, `status TEXT` (PENDING_APPROVAL / NOTIFIED / APPROVED / REJECTED / CANCELLED / EXPIRED), `steps_json TEXT` (JSON array of step descriptors for display/audit only), `inputs_json TEXT` (full inputs snapshot for reproducibility), `plan_hash TEXT` (SHA-256 of inputs_json for deduplication), `approved_at DATETIME`, `user_action TEXT`
- [x] Migration 047: create `tz_transition_steps` table with columns: `id INTEGER PRIMARY KEY`, `plan_id INTEGER REFERENCES tz_transition_plans(id)`, `medication_id INTEGER`, `step_number INTEGER`, `scheduled_at DATETIME`, `note TEXT`, `consumed_at DATETIME` (NULL until consumed)
- [x] Add `TZShiftPolicy string` field to `Medication` struct; include in all SELECT/INSERT/UPDATE queries in `CreateMedication`, `UpdateMedication`, `ListMedications`, `GetMedication`
- [x] Update the medication handler request structs, store interfaces, and frontend payloads so `tz_shift_policy` is accepted on create/edit and returned in list/get responses
- [x] Add `TZTransitionPlan` and `TZTransitionStep` structs; add store methods: `CreateTZTransitionPlan(plan)`, `GetLatestActiveOrPendingTZTransitionPlan()` (returns latest PENDING_APPROVAL / NOTIFIED / APPROVED plan), `UpdateTZTransitionPlanStatus(id, status, userAction string)`, `GetPlanByHash(hash string)`, `CreateTZTransitionSteps([]TZTransitionStep)`, `GetPendingStepsForPlan(planID int64)`, `MarkStepConsumed(stepID int64, consumedAt time.Time)`
- [x] If duplicate-send protection must be atomic, add a guarded status transition helper (for example: update `PENDING_APPROVAL` → `NOTIFIED` only if the current status still matches)
- [x] Write store tests for new plan and step CRUD methods using in-memory SQLite
- [x] Run `go test ./internal/store/...` — must pass

### Task 2: Engine package — policy rules, hard constraints, dry-run

**Files:**
- Create: `internal/domain/tzreschedule/policy.go`
- Create: `internal/domain/tzreschedule/engine.go`
- Create: `internal/domain/tzreschedule/engine_test.go`

- [x] `policy.go`: define `Policy` type (string const flexible/medium/strict); `MaxShiftPerDose(p Policy) time.Duration` (flexible=full offset in one step, medium=3h, strict=2h); `MinDoseInterval(scheduleIntervalHours int, p Policy) time.Duration` (flexible=60% of interval, medium=65%, strict=70%); `MaxDoseInterval(scheduleIntervalHours int, p Policy) time.Duration` (flexible=200%, medium=175%, strict=150%) — these are hard constraints never violated
- [x] `engine.go`:
  - Define `PlanInput`: `Medications []store.Medication`, `OldTZ string`, `NewTZ string`, `Now time.Time`, `LastIntakePerMedication map[int64]time.Time` (anchor dose — actual last intake from intake_log, not theoretical)
  - Define `TransitionStep{PlanID int64, MedicationID int64, MedName string, StepNumber int, TotalSteps int, ScheduledAt time.Time, Note string}`
  - Define `PlanSummary{Direction string, MaxShiftUsed time.Duration, ViolationsPrevented []string}` returned alongside steps for observability logging
  - Schedule source of truth: `base schedule` = user-defined schedule times interpreted in the target/new TZ; `old schedule` = same clock times interpreted in the old TZ. Shifts move dose times from old schedule toward base schedule, not from current wall clock
  - Direction / offset handling: compare UTC offsets at `now` for `oldTZ` vs `newTZ`; if the timezone names differ but the offsets are the same, the planner may still produce zero steps
  - Direction detection: if newOffset > oldOffset → eastbound (day shortened, compress carefully); if newOffset < oldOffset → westbound (day lengthened, more forgiving)
  - Weekly meds: skip entirely unless `tz_shift_policy` is explicitly non-flexible (keep original weekday/time in old TZ; only shift if user opted in via policy)
  - As-needed meds: always skip
  - Anchor dose: for strict and medium policies, compute first step's `ScheduledAt` from `LastIntakePerMedication[medID] + normal_interval ± allowed_shift` rather than from theoretical last schedule time
  - Hard constraint enforcement: before finalising each step, verify interval from previous step (or anchor) is >= MinDoseInterval and <= MaxDoseInterval; if violated, adjust step time or insert an extra intermediate step
  - Implement `GeneratePlan(input PlanInput) ([]TransitionStep, PlanSummary, error)` — deterministic, pure function (no side effects, safe to call multiple times)
- [x] `engine_test.go`: table-driven and golden-file tests covering: eastbound 6h strict (anchor-based start, 2h steps), westbound 6h medium (3h steps), flexible immediate (single step), weekly med skipped, as-needed skipped, same offset different TZ names yields no steps, hard constraint clamps an overly-short interval, MaxDoseInterval cap respected for strict
- [x] Run `go test ./internal/domain/tzreschedule/...` — must pass

### Task 3: Planner service — idempotency, audit, cancellation

**Files:**
- Create: `internal/domain/tzreschedule/planner.go`
- Modify: `internal/server/settings_handlers.go`

- [x] `planner.go`: define `PlannerService` interface with `GenerateIfChanged(oldTZ, newTZ string, now time.Time) error` and `CancelActivePlan(reason string) error`
- [x] Implement `GenerateIfChanged`:
  - Compute `inputsJSON` from all active non-archived daily medications (with last intake timestamps loaded from store), oldTZ, newTZ, now; compute `planHash = sha256(inputsJSON)`
  - Idempotency check 1: if `GetPlanByHash(planHash)` returns a recent plan (within 24h), skip silently
  - Idempotency check 2: if `GetLatestActiveOrPendingTZTransitionPlan()` returns a PENDING_APPROVAL / NOTIFIED / APPROVED plan, cancel it first (status → CANCELLED, user_action="superseded") then generate new; this handles TZ-changed-again case
  - Call `engine.GeneratePlan(input)`; if zero steps returned, do nothing
  - Save plan to store as PENDING_APPROVAL, save steps to `tz_transition_steps`
  - Emit structured slog log: `plan_id`, `old_tz`, `new_tz`, `direction`, `meds_count`, `steps_count`, `max_shift_used`, `violations_prevented`
- [x] In `settings_handlers.go` `handleUpdateSettings`: capture the current timezone before `RecordTimezone`, then after `RecordTimezone` succeeds read the new current timezone and call `PlannerService.GenerateIfChanged(oldTZ, newTZ, now)` only when the stored timezone string actually changed; errors are logged but do not fail the HTTP response
- [x] Explicitly document that this first iteration does not auto-generate plans for DST changes when the stored IANA timezone name is unchanged, because `timezone_history` only records timezone-string changes today
- [x] Write unit tests for planner using mock store: same-TZ skips, active plan is cancelled before new one, plan_hash deduplication, last-intake loaded into inputs
- [x] Run `go test ./internal/domain/tzreschedule/... ./internal/server/...` — must pass

### Task 4: Notifier + bot callbacks with risk labeling

**Files:**
- Create: `internal/scheduler/tz_plan_notifier.go`
- Create: `internal/bot/tz_plan_callbacks.go`
- Modify: `internal/bot/bot.go` (add callback routing)
- Modify: `internal/scheduler/scheduler.go` (register notifier in the shared scheduler)

- [x] `tz_plan_notifier.go`: `Check(ctx)` polls for PENDING_APPROVAL plans; formats Telegram message including:
  - Header: old TZ → new TZ, direction (eastbound/westbound), total medications affected
  - Safety block: "No doses skipped ✓", "No double doses ✓", "Max shift per step: Xh"
  - Per-medication section with label "(strict — gradual shift)" / "(medium)" / "(flexible — fast switch)": old schedule in old TZ, each transition step with exact timestamp in both old and new TZ local time, final local schedule in new TZ
  - Two inline buttons: `tz_plan_approve:<id>` and `tz_plan_reject:<id>`
  - After send: atomically transition PENDING_APPROVAL → NOTIFIED (prevents duplicate sends)
- [x] `tz_plan_callbacks.go`:
  - `handleTZPlanApprove(planID)`: load plan, set APPROVED + approved_at + user_action="approved"; log: `plan_id`, `user_action`, `approved_at`; reply with brief confirmation
  - `handleTZPlanReject(planID)`: set REJECTED + user_action="rejected"; log; reply confirming old schedule retained
- [x] Route `tz_plan_approve:` and `tz_plan_reject:` prefixes in bot callback router
- [x] Register `tz_plan_notifier.Check` in `internal/scheduler/scheduler.go` (every minute, same pattern as other checkers)
- [x] Write tests for message formatting (check safety block and per-med label presence) and callback state transitions
- [x] Run `go test ./internal/scheduler/... ./internal/bot/...` — must pass

### Task 5: Medication scheduler — timezone-aware + execute transition plan

**Files:**
- Modify: `internal/scheduler/medication.go`

- [ ] Load current user timezone via `store.GetCurrentTimezone()`; fall back to `time.Local` if not set
- [ ] When computing each scheduled dose time, use user timezone (base schedule = user-defined times in user/new TZ)
- [ ] Before scheduling a dose, call `store.GetLatestActiveOrPendingTZTransitionPlan()`:
  - If APPROVED plan exists: call `store.GetPendingStepsForPlan(planID)`; if a step for this medication is scheduled within the trigger window (same ±15 min logic as normal), use step's `ScheduledAt` and call `store.MarkStepConsumed(stepID, now)`; log step consumed
  - If all steps for a medication are consumed, resume normal user-TZ scheduling
  - If CANCELLED or EXPIRED plan encountered, ignore it and use normal scheduling
- [ ] Replace the current "any overdue unscheduled intake" behavior with an explicit due-window rule for both normal schedule targets and approved transition-plan steps, and update tests/docs to match that new rule
- [ ] Handle partial execution recovery: on each scheduler tick, resume from first unconsumed step (idempotent because `consumed_at` is set)
- [ ] If a new plan is created while scheduler is running (TZ changed again), the old plan will be CANCELLED — scheduler detects this and falls back to normal scheduling immediately
- [ ] Update CLAUDE.md: remove "deferred" caveat; note that medication scheduling now uses user TZ via timezone_history, with transition plans bridging TZ changes
- [ ] Write scheduler tests using golden-file pattern: approved plan → verify step times used; no plan → normal user-TZ scheduling; partially consumed plan → only remaining steps used; CANCELLED plan → normal scheduling
- [ ] Run `go test ./internal/scheduler/...` — must pass

### Task 6: Frontend — expose tz_shift_policy in medication form

**Files:**
- Modify: `web/static/js/app.js` (medication create/edit form) or whichever feature file owns that form

- [ ] Add `<select>` for "Timezone adjustment policy" to add/edit medication form; options: flexible (default) — "Switch immediately or in one step", medium — "Shift gradually, max 3h per dose", strict — "Very gradual, max 2h per step, no compressed intervals"
- [ ] Include `tz_shift_policy` in the medication request body for create and update (the current UI uses `POST` for both create and edit)
- [ ] Pre-select correct option from returned JSON when editing existing medication
- [ ] Run `go test ./...` — must pass (JS architecture test unchanged; no new globals)

### Task 7: Verify acceptance criteria

**Files:** none new

- [ ] Run `go test ./...`
- [ ] Run `go vet ./...`
- [ ] Update CLAUDE.md: document `tz_transition_plans` and `tz_transition_steps` tables in the schema section; document `tz_shift_policy` field; update medication scheduling note
- [ ] Move this plan to `docs/plans/completed/`
