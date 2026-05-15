# Store Method-Naming Consistency Pass

## Overview

After the per-domain store split, each repo's method names are still a snapshot of the historical `*Store` god-object's vocabulary. The result is a grab-bag of synonyms: `Create…` vs `Add…` for inserts, `Get…` vs `Fetch…` vs `Find…` vs `List…` for reads, and repo-package-qualified method names that re-state the domain redundantly (e.g. `medication.Repo.CreateMedication` reads as `medication.Repo.Create` would).

This plan applies a mechanical rename pass across all per-domain repos to converge on one verb per operation, drop redundant domain suffixes where the package name already provides them, and fix pluralization (`Get` for single-row, `List` for multi-row). It is a pure rename with no behavior or SQL change.

## Context

- Adopted from `docs/plans/2026-05-14-store-method-renaming-pass.md` (stub captured as follow-up from the completed split-store-package plan).
- Impacted packages: `internal/store/{medication,bp,weight,food,workout,vitals,diary,tz,settings,auth,push}` plus consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`.
- Adapter structs at `internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`, and `cmd/bot/tz_planner_adapter.go` forward to repos and may need explicit bridges when consumer-interface names diverge from repo method names.
- MCP registry operations in `internal/mcp/registry/operations_*.go` may reference store methods by string name — grep before each Task.
- The `store.Store = store.Repos` alias and type-name aliases (`store.Medication = medication.Medication`) are out of scope and must be left untouched.
- Per-PR validation: `go test ./...` + `go test -race ./...` + `golangci-lint run` must remain green at every Task boundary.

## Development Approach

- Testing approach: regular (renames are mechanical; existing tests catch behavior regressions)
- One Task per repo package, mirroring the original split order — keep each Task mechanical and reviewable
- Update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go` together with each repo rename — they are renamed together or not at all (CI catches mismatch)
- Complete each task fully (rename → adapters → consumer interfaces → tests green → linter clean) before moving to the next
- Update this plan when scope changes during implementation

## Testing Strategy

- Run `go test ./...` after every Task — must pass before proceeding
- Run `go test -race ./...` after every Task — must pass before proceeding
- Run `golangci-lint run` after every Task — must pass before proceeding
- No new tests required for renames themselves; existing tests verify behavior is preserved
- Add or adjust a unit test only if a method-name change requires a corresponding test-side update (e.g., a reflect-based adapter test)

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Update plan if implementation deviates from original scope

## Technical Details

### Naming rules to apply

- **One verb per operation**: `Create` / `Get` / `List` / `Update` / `Delete` / `Set` / `Upsert` / `Import` / `Batch…`. Drop `Add`, `Fetch`, `Find`.
- **Drop domain redundancy** where the package name already provides it: `medication.Repo.Create` (not `CreateMedication`), `bp.Repo.GetReadings` (not `GetBloodPressureReadings`). Keep the suffix only when a single repo owns multiple distinct entities (e.g. `medication.Repo.CreateIntake`, `medication.Repo.CreateRestock` are siblings).
- **Resolve `Get…` vs `Fetch…` to `Get…`** everywhere.
- **Pluralization**: `Get` for single-row, `List` for multi-row. Rename slice-returning readers like `GetExerciseLogs`, `GetIntakesSince` to `List…`.

### Out of scope

- Domain types / column names.
- Renames inside `internal/store/migrations/` SQL files.
- Splitting any repo or moving methods between repos.
- Removing the `store.Store = store.Repos` alias.

### Known risks

- **Adapter structs** (`internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`, `cmd/bot/tz_planner_adapter.go`) define method names that satisfy a consumer interface and forward to a repo. Renaming the repo method changes both sides. If a consumer interface is intentionally kept under the old name for callsite stability, the adapter needs an explicit one-line bridge instead of a same-name forward.
- **MCP registry** operations in `internal/mcp/registry/operations_*.go` reference store methods by string name in some handlers. Grep before each rename Task.
- **Reflect-based tests**: a handful of tests use reflect to assert method-name presence on adapters. Grep step above catches these.

### Rename mapping (built in Task 1)

Each subsection below lists the renames to apply in the corresponding repo Task. `KEEP` means the existing name already follows the rules.

Notes that apply across packages:
- The two scheduler/bot adapters and the mcp/tz adapters forward to repos by identical method names, so renaming the repo method renames the adapter forwarder verbatim — no explicit bridge needed.
- Consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go` use the same method names as the repos; rename both sides together.
- String references to store method names in production code are limited to two comment lines: `internal/mcp/registry/operations_medications.go:15` (mentions `MedicationStore.AddRestock`) and `internal/mcp/registry/operations_health.go:147` (mentions `BloodPressureService.CreateBloodPressureReading` — a service method, not a repo method, but worth updating if its underlying service method is renamed elsewhere). No `reflect.MethodByName` usages on store types — grep returned zero hits.

#### Task 2 — `medication.Repo`

- `CreateMedication` → `Create`
- `ListMedications` → `List`
- `GetMedication` → `Get`
- `UpdateMedication` → `Update`
- `DeleteMedication` → `Delete`
- `CanDeleteMedication` → `CanDelete`
- `SetMedicationSupplement` → `SetSupplement`
- `UpdateMedicationCreatedAt` → `UpdateCreatedAt`
- `AddRestock` → `CreateRestock`
- `GetRestockHistory` → `ListRestocks`
- `GetMedicationsLowOnStock` → `ListLowOnStock`
- `GetPendingIntakes` → `ListPendingIntakes`
- `GetTakenIntakesBySchedule` → `ListTakenIntakesBySchedule`
- `GetIntakeHistory` → `ListIntakeHistory`
- `AddIntakeReminder` → `CreateIntakeReminder`
- `GetIntakeReminders` → `ListIntakeReminders`
- `GetBatchIntakeReminders` → `BatchGetIntakeReminders` (move `Batch` to front for parity with `BatchGetIntakesBySchedule`)
- `GetPendingIntakesBySchedule` → `ListPendingIntakesBySchedule`
- `GetPendingIntakesForMedication` → `ListPendingIntakesForMedication`
- `GetIntakesSince` → `ListIntakesSince`
- Update comment at `internal/mcp/registry/operations_medications.go:15` (`AddRestock` → `CreateRestock`).
- KEEP: `DecrementInventory`, `IncrementInventory`, `SetInventory`, `GetDaysOfStockRemaining`, `IsLowOnStock`, `CreateIntake`, `CreateManualIntake`, `ConfirmIntake`, `SkipIntake`, `UpdateIntake`, `SnoozeIntake`, `GetIntake`, `GetIntakeBySchedule`, `BatchGetIntakesBySchedule`, `ConfirmIntakesBySchedule`, `DeleteIntake`.

#### Task 3 — `bp.Repo`

- `GetBPGoal` → `GetGoal`
- `SetBPGoal` → `SetGoal`
- `CreateBloodPressureReading` → `CreateReading`
- `GetBloodPressureReadings` → `ListReadings`
- `DeleteBloodPressureReading` → `DeleteReading`
- `ImportBloodPressureReadings` → `ImportReadings`
- `GetBPDailyWeightedStats` → `GetDailyWeightedStats`
- `GetBPReminderState` → `GetReminderState`
- `SetBPReminderEnabled` → `SetReminderEnabled`
- `SnoozeBPReminder` → `SnoozeReminder`
- `DontBugMeBPReminder` → `DontBugMeReminder`
- `UpdateBPReminderNotificationSent` → `UpdateReminderNotificationSent`
- `ClearBPReminderNotificationMessage` → `ClearReminderNotificationMessage`
- `GetLastBPReading` → `GetLastReading`
- `GetDominantBPCategory` → `GetDominantCategory`
- `GetUsersForBPReminders` → `ListUsersForReminders`
- `BatchGetBPReminderStates` → `BatchGetReminderStates`
- `BatchGetLastBPReadings` → `BatchGetLastReadings`
- Update comment at `internal/mcp/registry/operations_health.go:147` if it still references the old method name after BP service renames.
- KEEP: `SetClock`, `CalculatePreferredReminderHour`, `UpdatePreferredReminderHour`.

#### Task 4 — `weight.Repo`

- `CreateWeightLog` → `CreateLog`
- `GetWeightLogs` → `ListLogs`
- `DeleteWeightLog` → `DeleteLog`
- `GetLastWeightLog` → `GetLastLog`
- `GetLastWeightLogExcluding` → `GetLastLogExcluding`
- `GetHighestWeightRecord` → `GetHighestLog`
- `BatchGetLastWeightLogs` → `BatchGetLastLogs`
- `GetWeightGoal` → `GetGoal`
- `SetWeightGoal` → `SetGoal`
- `GetWeightUnitPreference` → `GetUnitPreference`
- `SetWeightUnitPreference` → `SetUnitPreference`
- `GetWeightReminderState` → `GetReminderState`
- `SetWeightReminderEnabled` → `SetReminderEnabled`
- `SnoozeWeightReminder` → `SnoozeReminder`
- `DontBugMeWeightReminder` → `DontBugMeReminder`
- `UpdateWeightReminderNotificationSent` → `UpdateReminderNotificationSent`
- `ClearWeightReminderNotificationMessage` → `ClearReminderNotificationMessage`
- `CalculatePreferredWeightReminderHour` → `CalculatePreferredReminderHour`
- `UpdatePreferredWeightReminderHour` → `UpdatePreferredReminderHour`
- `GetUsersForWeightReminders` → `ListUsersForReminders`
- `GetWeightReminderStates` → `ListReminderStates`

#### Task 5 — `food.Repo`

- `UpsertFoodProduct` → `UpsertProduct`
- `GetFoodProductByName` → `GetProductByName`
- `GetFoodProductByID` → `GetProductByID`
- `UpdateFoodProduct` → `UpdateProduct`
- `DeleteFoodProduct` → `DeleteProduct`
- `GetFoodProducts` → `ListProducts`
- `SearchFoodProducts` → `SearchProducts`
- `SearchRemoteFoodAPI` → `SearchRemoteAPI`
- `CreateFoodLog` → `CreateLog`
- `UpdateFoodLog` → `UpdateLog`
- `GetFoodLogs` → `ListLogs`
- `DeleteFoodLog` → `DeleteLog`
- `GetFoodStats` → `GetStats`
- `GetFoodTargets` → `GetTargets`
- `SetFoodTargets` → `SetTargets`
- KEEP: `CreateMealFromLogs` (distinct compound operation).

#### Task 6 — `workout.Repo`

Workout owns many sibling entities (groups, variants, exercises, sessions, exercise logs, library items, snapshots, mi-band). Keep the entity discriminator; only drop the redundant `Workout` prefix.

- `CreateWorkoutGroup` → `CreateGroup`
- `ListWorkoutGroups` → `ListGroups`
- `GetWorkoutGroup` → `GetGroup`
- `UpdateWorkoutGroup` → `UpdateGroup`
- `DeleteWorkoutGroup` → `DeleteGroup`
- `CreateWorkoutVariant` → `CreateVariant`
- `GetWorkoutVariant` → `GetVariant`
- `UpdateWorkoutVariant` → `UpdateVariant`
- `DeleteWorkoutVariant` → `DeleteVariant`
- `AddExerciseToVariant` → `CreateExerciseInVariant`
- `GetWorkoutExercise` → `GetExercise`
- `UpdateWorkoutExercise` → `UpdateExercise`
- `DeleteWorkoutExercise` → `DeleteExercise`
- `GetAllUniqueExercises` → `ListAllUniqueExercises`
- `CreateWorkoutSession` → `CreateSession`
- `CreateAdHocWorkoutSession` → `CreateAdHocSession`
- `GetWorkoutSession` → `GetSession`
- `UpdateWorkoutSessionNotes` → `UpdateSessionNotes`
- `GetExerciseLogs` → `ListExerciseLogs`
- `GetGroupSnapshots` → `ListGroupSnapshots`
- `GetWorkoutHistory` → `ListHistory`
- `GetSnoozedSessions` → `ListSnoozedSessions`
- `GetExerciseStats` → `ListExerciseStats`
- `GetActiveSessions` → `ListActiveSessions`
- `GetDistinctExerciseNamesForUser` → `ListDistinctExerciseNamesForUser`
- Mi-band sub-area: drop the redundant `Workout` suffix; keep `MiBand` as the entity discriminator.
  - `CheckDuplicateMiBandWorkout` → `CheckDuplicateMiBand`
  - `InsertMiBandWorkout` → `InsertMiBand`
  - `ImportMiBandWorkouts` → `ImportMiBand`
  - `ListMiBandWorkouts` → `ListMiBand`
  - `GetMiBandWorkoutGPS` → `GetMiBandGPS`
  - `GetMiBandWorkout` → `GetMiBand`
  - `DeleteMiBandWorkout` → `DeleteMiBand`
  - `UpdateMiBandWorkout` → `UpdateMiBand`
- KEEP: `ListVariantsByGroup`, `ListExercisesByVariant`, `ListExerciseLibrary`, `GetExerciseLibraryItem`, `CreateExerciseLibraryItem`, `UpdateExerciseLibraryItem`, `DeleteExerciseLibraryItem`, `GetRotationState`, `InitializeRotation`, `AdvanceRotation`, `CreatePlannedAdHocSession`, `ListNotifiedAdHocSessions`, `ListPendingAdHocSessions`, `IsAdHocSession`, `GetLatestSessionScheduledDate`, `GetSessionByGroupAndDate`, `UpdateSessionStatus`, `StartSession`, `UpdateSessionVariant`, `CompleteSession`, `SkipSession`, `PreSkipSession`, `CancelPreSkip`, `DeleteSession`, `SnoozeSession`, `ClearSnooze`, `SetSessionNotificationMessageID`, `LogExercise`, `LogExerciseWithSource`, `UpdateExerciseLog`, `UpdateExerciseLogStatus`, `DeleteExerciseLog`, `UpsertExerciseLogByName`, `SetExerciseLogSource`, `GetExerciseLogByID`, `GetExerciseLogBySessionExerciseSource`, `PropagateExerciseToSchedule`, `GetExerciseLogBySessionAndExercise`, `CreateGroupSnapshot`, `ListRecentExerciseLogsByName`.

#### Task 7 — `vitals.Repo`

- `GetDayStats` → `ListDayStats`
- `GetSleepLogs` → `ListSleepLogs`
- `GetVitalsHeart` → `ListHeart`
- `GetVitalsSpO2` → `ListSpO2`
- `GetVitalsStress` → `ListStress`
- KEEP: `ImportSleepLogs`, `ImportDayStats`, `ImportVitals` (the `Vitals` here is the aggregate import covering heart/spo2/stress and stays meaningful even though redundant with the package).

#### Task 8 — `tz.Repo`

- `GetCurrentTimezone` → `GetCurrent`
- `RecordTimezone` → `Record`
- `CreateTZTransitionPlan` → `CreateTransitionPlan`
- `GetLatestCompletedTZTransitionPlan` → `GetLatestCompletedTransitionPlan`
- `GetLatestActiveOrPendingTZTransitionPlan` → `GetLatestActiveOrPendingTransitionPlan`
- `UpdateTZTransitionPlanStatus` → `UpdateTransitionPlanStatus`
- `SetTZTransitionPlanApproved` → `SetTransitionPlanApproved`
- `SetTZTransitionPlanRejected` → `SetTransitionPlanRejected`
- `RejectTZTransitionPlanAndRevertTimezone` → `RejectTransitionPlanAndRevertTimezone`
- `CreateTZTransitionPlanWithSteps` → `CreateTransitionPlanWithSteps`
- `CreateTZTransitionSteps` → `CreateTransitionSteps`
- `GetPendingStepsForPlan` → `ListPendingStepsForPlan`
- KEEP: `MarkPlanNotified`, `ResetPlanToPending`, `GetPlanByHash`, `GetLatestConsumedStepTimePerMed` (single derived map keyed by med), `MarkStepConsumed`.

#### Task 9 — `settings.Repo`

- `GetChangedTagsSince` → `ListChangedTagsSince`
- KEEP: all feature-flag get/set pairs (`GetFoodIntakeEnabled` / `SetFoodIntakeEnabled` and siblings) — the suffix is the column name, not a domain-redundancy. KEEP `GetBool`, `SetBool`, `GetTabOrder`, `SetTabOrder`, `GetDismissedTZSuggestion`, `SetDismissedTZSuggestion`, `GetLastDownload`, `UpdateLastDownload`, `GetLatestChangeCursor`, `PruneChangeEvents`.

#### Task 10 — `auth.Repo`

- `CreateAPIToken` → `CreateToken`
- `ListAPITokens` → `ListTokens`
- `DeleteAPIToken` → `DeleteToken`
- `FindAPITokenByHash` → `GetTokenByHash` (the only `Find…` in the codebase, called out in the plan)
- `TouchAPITokenLastUsed` → `TouchTokenLastUsed`
- KEEP: `SetClock`, `TryUseLoginHash`.

#### `push.Repo` (no Task)

Already minimal: `Create`, `List`, `Delete`, `Disable`. No renames.

#### `diary.Repo` (no Task)

Already minimal: `Create`, `List`, `Delete`. No renames.

## Implementation Steps

### Task 1: Inventory and rename mapping

- [x] grep every repo package under `internal/store/` for exported method names and produce an old→new mapping per package
- [x] confirm the mapping against the naming rules in Technical Details (one verb, drop redundancy, `Get` vs `List`)
- [x] grep the codebase for string references to store method names (`internal/mcp/registry/operations_*.go`, reflect-based tests, comments) and note any callsites that need manual updates beyond `gopls rename`
- [x] note adapter methods in `internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`, `cmd/bot/tz_planner_adapter.go` that will need to follow consumer-interface names
- [x] document the mapping inline in this plan (append a "Rename mapping" subsection under Technical Details) so each subsequent Task can reference it
- [x] run project tests - must pass before next task

### Task 2: Rename medication repo methods

- [x] apply rename mapping to `internal/store/medication/` (e.g. `CreateMedication` → `Create`, `AddRestock` → `CreateRestock`, `AddIntakeReminder` → `CreateIntakeReminder`)
- [x] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go` to match
- [x] update adapter forwarders in `internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`, `cmd/bot/tz_planner_adapter.go` where they touch medication
- [x] update MCP registry operation handlers in `internal/mcp/registry/operations_medication*.go` if they reference renamed methods
- [x] update tests inside `internal/store/medication/` and any caller tests
- [x] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 3: Rename BP repo methods

- [x] apply rename mapping to `internal/store/bp/` (e.g. `GetBloodPressureReadings` → `GetReadings` or `ListReadings`; `Get…` vs `Fetch…` collapses to `Get…`)
- [x] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [x] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [x] update MCP registry operation handlers in `internal/mcp/registry/operations_bp*.go`
- [x] update tests inside `internal/store/bp/` and any caller tests
- [x] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 4: Rename weight repo methods

- [x] apply rename mapping to `internal/store/weight/`
- [x] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [x] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [x] update MCP registry operation handlers in `internal/mcp/registry/operations_weight*.go`
- [x] update tests inside `internal/store/weight/` and any caller tests
- [x] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 5: Rename food repo methods

- [ ] apply rename mapping to `internal/store/food/`
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_food*.go`
- [ ] update tests inside `internal/store/food/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 6: Rename workout repo methods

- [ ] apply rename mapping to `internal/store/workout/` including the mi-band sub-area (e.g. `GetExerciseLogs` → `ListExerciseLogs`)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_workout*.go`
- [ ] update tests inside `internal/store/workout/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 7: Rename vitals repo methods

- [ ] apply rename mapping to `internal/store/vitals/` (sleep + day stats; rename slice-returning readers like `GetIntakesSince` → `ListIntakesSince` if applicable)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_vitals*.go`
- [ ] update tests inside `internal/store/vitals/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 8: Rename tz repo methods

- [ ] apply rename mapping to `internal/store/tz/` (timezone history + transition plans/steps)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders especially `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_tz*.go` if any
- [ ] update tests inside `internal/store/tz/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 9: Rename settings repo methods

- [ ] apply rename mapping to `internal/store/settings/` (incl. download cursor + change_events)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_settings*.go` if any
- [ ] update tests inside `internal/store/settings/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 10: Rename auth repo methods

- [ ] apply rename mapping to `internal/store/auth/` — specifically rename `FindAPITokenByHash` → `GetAPITokenByHash` (the only `Find…` in the codebase), plus any other Find/Fetch holdovers
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_auth*.go` if any
- [ ] update tests inside `internal/store/auth/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 11: Verify acceptance criteria

- [ ] grep the codebase for any remaining `Add`, `Fetch`, `Find` prefixed exported methods on `internal/store/**/Repo` — should be zero
- [ ] grep for redundant domain suffixes (`CreateMedication`, `GetBloodPressureReadings`, etc.) — should be zero where the package name already provides the domain
- [ ] verify `store.Store = store.Repos` alias is untouched
- [ ] verify `internal/store/migrations/` SQL files are untouched
- [ ] verify type aliases (`store.Medication = medication.Medication`) are untouched
- [ ] run full project test suite: `go test ./...` and `go test -race ./...`
- [ ] run project linter: `golangci-lint run` - all issues must be fixed

## Post-Completion

*Items requiring manual intervention - no checkboxes, informational only*

- This pass is mechanical and ships as ~9 PRs (one per repo). Squash-merging is not used here — follow the project's "merge with merge commit" rule.
- The Open Questions from the original stub (renaming `Repo` itself, aligning `Repos` aggregator field names) are deferred and not part of this plan.
- After completion, consider a follow-up to revisit type-name awkwardness (`medication.Medication` → `medication.Record` or `medication.Entry`) as a separate pass.
