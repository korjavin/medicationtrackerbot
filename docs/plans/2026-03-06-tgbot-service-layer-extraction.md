# TG Bot Service Layer Extraction

## Overview

Refactor the Telegram bot packages to remove all business logic. The TG bot becomes a thin communication channel — like web push notifications — responsible only for parsing Telegram-specific data and sending/deleting messages. All domain decisions move to `internal/domain/`.

**Problem it solves:**
- Business logic currently duplicated or split between bot and server handlers
- Bot callbacks are hard to unit-test (require Telegram mocking)
- Adding new channels (e.g., new notification type) would require duplicating logic

**Key benefit:** after this refactoring, the bot only knows _how_ to send a Telegram message; `internal/domain/` knows _what_ to do.

## Context (from discovery)

- Files involved: `internal/bot/bot.go` (1599 lines), `internal/bot/workout_callbacks.go`, `internal/bot/bp_callbacks.go`, `internal/bot/weight_callbacks.go`, `internal/bot/food_commands.go`, `internal/bot/store_interfaces.go`
- Related patterns found: `internal/workout/service.go` already extracts workout session management (perfect model), `internal/domain/food.go` already extracts food parsing
- Dependencies identified: `internal/store/` (store interfaces), `internal/domain/` (existing domain package to extend)
- Model to follow: `internal/workout/service.go` pattern — interface + struct + methods

## Development Approach

- **Testing approach**: Regular (move code, update/add tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Run `go test ./...` after each task
- Maintain backward compatibility (no feature regressions)

## Testing Strategy

- **Unit tests**: Each new domain function gets table-driven tests with mock stores — no Telegram dependency
- **Existing bot tests**: Must continue to pass after refactoring (update imports/calls as needed)
- **Integration**: `go build ./...` must pass after each task

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code changes, tests, linting in this repo
- **Post-Completion**: manual verification of Telegram bot behavior end-to-end

## Implementation Steps

---

### Task 1: Understand existing domain structure and define store interfaces

- [x] Read `internal/domain/` to understand existing patterns and package layout
- [x] Read `internal/workout/service.go` to confirm the interface+struct pattern to follow
- [x] Read `internal/bot/store_interfaces.go` to understand current bot store interface
- [x] Identify which store methods are needed for each domain service (medication, reminder, exercise)
- [x] Document the three new files to create: `domain/medication.go`, `domain/reminder.go`, `domain/exercise.go`
- [x] Run `go test ./...` — baseline must pass before task 2

---

### Task 2: Create `internal/domain/medication.go` service

Extract all medication business logic from `internal/bot/bot.go` callbacks:
- `confirm_intake:<id>` (lines ~358-406)
- `skip_intake:<id>` (lines ~407-460)
- `confirm:<medID>` legacy (lines ~461-553)
- `log:<medID>` (lines ~553-579)
- `confirm_schedule:<timestamp>` (lines ~579-599)

Steps:
- [x] Create `internal/domain/medication.go` with `MedicationService` interface and `medicationService` struct
- [x] Implement `ConfirmIntakeWithCleanup(ctx, intakeID, takenAt) (reminderMsgIDs []int, err error)` — get intake, validate PENDING, get reminders, confirm, decrement inventory
- [x] Implement `SkipSupplementIntake(ctx, intakeID) (reminderMsgIDs []int, err error)` — validate supplement type before skipping
- [x] Implement `LogMedicationNow(ctx, userID, medID) error` — create intake + immediately confirm + decrement inventory
- [x] Implement `ConfirmScheduleWithCleanup(ctx, userID, scheduledAt) (reminderMsgIDs []int, err error)` — batch confirm for time slot
- [x] Create `internal/domain/medication_test.go` with table-driven tests using mock store
- [x] Write tests for `ConfirmIntakeWithCleanup`: pending intake, already-taken intake, missing intake
- [x] Write tests for `SkipSupplementIntake`: supplement ok, non-supplement rejected
- [x] Write tests for `ConfirmScheduleWithCleanup`: multiple intakes, empty slot
- [x] Run `go test ./internal/domain/...` — must pass before task 3

---

### Task 3: Refactor `internal/bot/bot.go` medication callbacks to use domain service

- [x] Add `medSvc domain.MedicationService` field to `Bot` struct in `bot.go`
- [x] Update `New()` constructor to accept and inject `domain.MedicationService`
- [x] Refactor `confirm_intake` callback: call `medSvc.ConfirmIntakeWithCleanup()`, delete returned reminders, send Telegram response
- [x] Refactor `skip_intake` callback: call `medSvc.SkipSupplementIntake()`, same cleanup pattern
- [x] Refactor `confirm` (legacy) callback: call `medSvc.ConfirmIntakeWithCleanup()`
- [x] Refactor `log` callback: call `medSvc.LogMedicationNow()`
- [x] Refactor `confirm_schedule` callback: call `medSvc.ConfirmScheduleWithCleanup()`
- [x] Update `cmd/bot/main.go` to construct and inject `MedicationService`
- [x] Update `internal/bot/bot_commands_test.go` and `commands_test.go` if they test these callbacks
- [x] Run `go test ./internal/bot/...` and `go build ./...` — must pass before task 4

---

### Task 4: Create `internal/domain/exercise.go` service

Extract exercise logging logic from `internal/bot/workout_callbacks.go`:
- `exercise_done` (idempotent log with defaults)
- `exercise_skip` (idempotent log with skipped status)
- `exercise_edit` (log with defaults, mark for full edit in web)

Steps:
- [x] Create `internal/domain/exercise.go` with `ExerciseService` interface and struct
- [x] Implement `LogExercise(ctx, sessionID, exerciseID, status string) error` — idempotent upsert: if log exists update status, else create with target defaults
- [x] Implement `CheckSessionCompletion(ctx, sessionID, variantID) (done bool, completedCount, totalCount int, err error)` — determine if all planned exercises handled
- [x] Create `internal/domain/exercise_test.go` with tests using mock store
- [x] Write tests for `LogExercise`: new log, existing skipped→completed transition, existing completed (no-op)
- [x] Write tests for `CheckSessionCompletion`: all done, partial, none done
- [x] Run `go test ./internal/domain/...` — must pass before task 5

---

### Task 5: Refactor `internal/bot/workout_callbacks.go` to use domain service

- [x] Add `exerciseSvc domain.ExerciseService` field to `Bot` struct
- [x] Update constructor to inject `ExerciseService`
- [x] Refactor `exercise_done` callback: call `exerciseSvc.LogExercise(..., "completed")`, use `CheckSessionCompletion` to decide if session is done
- [x] Refactor `exercise_skip` callback: call `exerciseSvc.LogExercise(..., "skipped")`
- [x] Refactor `exercise_edit` callback: call `exerciseSvc.LogExercise(..., "completed")` then show web edit link
- [x] Remove now-dead inline logic from workout_callbacks.go
- [x] Update `internal/bot/workout_new_test.go` and `workout_test.go` to match refactored bot
- [x] Run `go test ./internal/bot/...` — must pass before task 6

---

### Task 6: Create `internal/domain/reminder.go` service

Extract BP/weight reminder management from `internal/bot/bp_callbacks.go` and `internal/bot/weight_callbacks.go`:

- [x] Create `internal/domain/reminder.go` with `ReminderService` interface and struct
- [x] Implement `SnoozeBPReminder(ctx, userID) error`
- [x] Implement `BlockBPReminders(ctx, userID) error`
- [x] Implement `SnoozeWeightReminder(ctx, userID) error`
- [x] Implement `BlockWeightReminders(ctx, userID) error`
- [x] Create `internal/domain/reminder_test.go` with tests (these are thin wrappers, test store delegation and error propagation)
- [x] Run `go test ./internal/domain/...` — must pass before task 7

---

### Task 7: Refactor `internal/bot/bp_callbacks.go` and `internal/bot/weight_callbacks.go`

- [x] Add `reminderSvc domain.ReminderService` field to `Bot` struct
- [x] Update constructor to inject `ReminderService`
- [x] Refactor `bp_snooze` callback: call `reminderSvc.SnoozeBPReminder()`
- [x] Refactor `bp_dontbug` callback: call `reminderSvc.BlockBPReminders()`
- [x] Refactor `weight_snooze` callback: call `reminderSvc.SnoozeWeightReminder()`
- [x] Refactor `weight_dontbug` callback: call `reminderSvc.BlockWeightReminders()`
- [x] Run `go test ./internal/bot/...` — must pass before task 8

---

### Task 8: Verify `internal/bot/food_commands.go` already uses domain

- [ ] Read `food_commands.go` — verify it already calls `domain.ParseIntakeArgs()` and `domain.CalculateMacros()`
- [ ] If any inline logic remains, extract it to `internal/domain/food.go`
- [ ] Run `go test ./internal/bot/...`

---

### Task 9: Verify acceptance criteria

- [ ] Audit `internal/bot/bot.go` — no direct store calls for business decisions (only allowed: auth check, fetching data needed for Telegram display)
- [ ] Audit `internal/bot/workout_callbacks.go` — delegates to workout service and exercise service
- [ ] Audit `internal/bot/bp_callbacks.go` and `weight_callbacks.go` — delegates to reminder service
- [ ] Run full test suite: `go test ./...` — all tests pass
- [ ] Run `go build ./...` — clean build
- [ ] Run linter: `golangci-lint run` — no new issues

---

### Task 10: Update documentation

- [ ] Update `CLAUDE.md` to reflect new domain service pattern (mention `domain/medication.go`, `domain/exercise.go`, `domain/reminder.go`)
- [ ] If new patterns are stable, add to project memory

---

## Technical Details

### Bot struct before → after

**Before:**
```go
type Bot struct {
    api    *tgbotapi.BotAPI
    meds   MedsStore
    // ... many store fields
}
```

**After:**
```go
type Bot struct {
    api         *tgbotapi.BotAPI
    medSvc      domain.MedicationService
    exerciseSvc domain.ExerciseService
    reminderSvc domain.ReminderService
    workoutSvc  workoutsvc.WorkoutService  // already exists
    // ... minimal store access for data display
}
```

### Service pattern (follow internal/workout/service.go)

```go
// internal/domain/medication.go

type MedicationStore interface {
    GetIntake(id int64) (*store.IntakeLog, error)
    // ... minimal interface
}

type MedicationService interface {
    ConfirmIntakeWithCleanup(ctx context.Context, intakeID int64, takenAt time.Time) (reminderMsgIDs []int, err error)
    SkipSupplementIntake(ctx context.Context, intakeID int64) (reminderMsgIDs []int, err error)
    LogMedicationNow(ctx context.Context, userID, medID int64) error
    ConfirmScheduleWithCleanup(ctx context.Context, userID int64, scheduledAt time.Time) (reminderMsgIDs []int, err error)
}

type medicationService struct {
    store MedicationStore
}

func NewMedicationService(s MedicationStore) MedicationService {
    return &medicationService{store: s}
}
```

## Post-Completion

**Manual verification:**
- Open Telegram, send a medication confirmation callback — verify ✅ response
- Open Telegram, confirm a workout exercise — verify exercise log created
- Open Telegram, snooze a BP reminder — verify reminder is snoozed
- Verify web UI medication/workout features still work (shared service layer)

**Future opportunities** (out of scope for this plan):
- Inject same `MedicationService` into `internal/server/` handlers to eliminate server-side duplication
- Add metrics/logging at service layer for observability
