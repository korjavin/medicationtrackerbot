# Thin workout HTTP handlers into the domain service + move `internal/workout` → `internal/domain/workout`

## Overview

`internal/server/workout_handlers.go` (1,842 lines) violates the project's
own Critical Rule #1 (domain service pattern): roughly 1,000 lines of
business logic — the next-workout scheduling priority engine, stats
computation, session listing/enrichment, and status-transition rules —
live in HTTP handlers and call the workout store directly (`s.workouts.*`),
while `internal/workout/service.go` (219 lines) only covers
start/snooze/skip/complete/ad-hoc-create.

This plan:
1. Moves `internal/workout` to `internal/domain/workout` so all domain
   services live in one place (mechanical: no import cycles, 5 importers,
   no name conflicts — verified during discovery).
2. Extracts the business logic from the fat handlers into new
   `WorkoutService` methods, leaving every handler thin
   (parse → service call → encode JSON).

**Strictly behavior-preserving.** No route paths, status codes, or JSON
payload shapes may change — the frontend, Telegram bot, scheduler, and
MCP registry all depend on them. No new features.

## Context (from discovery)

- Fat handlers (line refs in `internal/server/workout_handlers.go`):
  - `handleGetNextWorkout` (605–953, ~349 lines): 3-priority scheduling
    engine (active today → snoozed → pending), timezone-aware day
    boundaries, ad-hoc (`group_id = -1`) placeholder-log counting.
  - `handleGetWorkoutStats` (965–1079, ~115 lines): filtering + volume /
    sessions-per-week computations.
  - `handleListWorkoutSessions` (468–570, ~103 lines): date/status
    filtering + group/variant enrichment + rotation state.
  - `handleGetSessionDetails` (571–604): session + logs + enrichment.
  - `handleUpdateSessionStatus` (1653–1732): status transition rules,
    rotation advancement, completion notification dispatch.
  - `handleAddExerciseToSession` (1277–1384), `handleUpdateExerciseLog`
    (1136–1222), `handleSnoozeWorkoutSession` (1385–1438),
    `handlePreSkipWorkoutSession` / `handleCancelPreSkip…` (1439–1502),
    `handleNextVariantWorkoutSession` (1503–1553),
    `handleGetRotationState` (1080–1099), `handleInitializeRotation`
    (1100–1122).
- Thin handlers (group/variant/exercise/library CRUD, deletes) are fine
  and stay as-is.
- `internal/workout/service.go` already has the right pattern: narrow
  `WorkoutStore` interface, `TZStore`, injectable `Now func() time.Time`
  clock, table-driven tests in `service_test.go` (418 lines).
- Importers of `internal/workout`: `internal/bot/bot.go`,
  `internal/scheduler/scheduler.go`, `internal/scheduler/workout.go`,
  `internal/server/server.go`, `internal/server/workout_schedule_handlers.go`.
  `internal/workout` imports only `internal/store` — no cycle risk.
- Server wiring: `server.go:315` `workoutSvc: workoutsvc.New(s.Workout, s.TZ)`;
  handlers use `s.workoutSvc` for transitions but `s.workouts` (store)
  directly for everything else.
- CLAUDE.md and `docs/architecture.md` reference `internal/workout` as
  "the reference service pattern" — both need path updates at the end.

## Development Approach

- **Testing approach**: Regular (code first, then tests).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes
  in that task — service-level table-driven tests with a fake store and
  fixed clock, plus keeping existing handler tests green unmodified
  (they are the behavior-preservation safety net).
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run `go test ./...` after each task.
- Maintain backward compatibility: identical routes, status codes, and
  JSON shapes. Where a handler today builds an anonymous
  struct / `map[string]interface{}` response, the extracted service
  returns a named struct whose json tags reproduce the current output
  byte-for-byte (field names, omitted/null semantics).
- Per the domain-service pattern, the service extends its own narrow
  `WorkoutStore` interface with only the store methods it needs; do not
  embed the whole store.
- Notification dispatch (bot interactor) stays in the transport layer:
  service methods return an outcome the handler uses to decide whether
  to notify.

## Testing Strategy

- **Unit tests**: required for every task. New service methods get
  table-driven tests in `internal/domain/workout/` with a fake store and
  fixed `Now`. Existing `internal/server` handler tests must keep passing
  unmodified wherever possible — if one must change, the change must be
  mechanical (e.g. import path), never an expectation change.
- **E2E tests**: none for backend-only refactor; frontend Vitest suite
  (`pnpm test`) must stay green (it exercises the JSON contracts via
  fixtures in some suites).

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## Implementation Steps

### Task 1: Move `internal/workout` → `internal/domain/workout`

- [x] `git mv internal/workout internal/domain/workout` (package name
  stays `workout`; files: `service.go`, `service_test.go`)
- [x] update import paths in the 5 importers: `internal/bot/bot.go`,
  `internal/scheduler/scheduler.go`, `internal/scheduler/workout.go`,
  `internal/server/server.go`, `internal/server/workout_schedule_handlers.go`
  (keep the existing `workoutsvc` import alias where used) — note: also
  updated 6 test-file importers carrying the same alias (`internal/bot/{common_test,workout_test,bench_test}.go`,
  `internal/scheduler/{workout_crosstz_test,workout_scheduler_test,workout_adhoc_test}.go`,
  `internal/server/workout_handlers_test.go`)
- [x] grep the whole repo for `internal/workout` to catch any remaining
  references (docs are handled in the final task; fix code references now)
- [x] verify both build modes compile: `go build ./...` and
  `go build -tags mobile ./...`
- [x] run `go test ./...` — must pass before task 2

### Task 2: Extract the next-workout engine into `WorkoutService.GetNext`

- [x] define a `NextWorkout` response struct in
  `internal/domain/workout/next.go` with json tags exactly matching the
  current handler output (session map fields `id`, `scheduled_date`,
  `scheduled_time`, `status`, `is_snoozed`, `snoozed_until`, `is_today`;
  top-level `group_name`, `variant_name`, `exercises_count`,
  `variant_id`, `group_id`, `is_rotating`; plus whatever the snoozed /
  pending priority branches add — read all of
  `workout_handlers.go:605-953` before coding) — note: `Session` is kept
  as `map[string]interface{}` (not a typed struct) precisely because the
  three branches differ on whether `snoozed_until` is emitted: active +
  snoozed always include it (possibly null), pending omits it entirely;
  a single typed struct with `omitempty` cannot reproduce "present-but-null".
- [x] add `GetNext(userID int64) (*NextWorkout, error)` to
  `WorkoutService`; move the 3-priority engine (active today → snoozed →
  pending), timezone-aware `now` computation (reuse the service's `tz` +
  `Now` fields via new `localNow()` helper), and the ad-hoc
  `group_id == -1` placeholder-log counting into it
- [x] extend the service's `WorkoutStore` interface with the read methods
  the engine needs (`ListActiveSessions`, `ListSnoozedSessions`,
  `ListGroups`, `ListVariantsByGroup`, `GetVariant`,
  `ListExercisesByVariant`, `ListExerciseLogs`, `GetRotationState`,
  `GetSessionByGroupAndDate`, `CreateSession`)
- [x] shrink `handleGetNextWorkout` to: getUserID → `s.workoutSvc.GetNext`
  → encode (preserve the "no workout" response shape exactly — a nil
  `*NextWorkout` marshals to JSON `null`, matching the legacy
  `Encode(nil)`). Lazy-create failures surface via a typed
  `CreateSessionError` so the handler reproduces the legacy
  "Error creating session: <err>" 500 body without a capitalized error
  string (staticcheck ST1005); other engine errors map to a plain 500.
- [x] write table-driven tests in `internal/domain/workout/next_test.go`:
  active-session-today wins over snoozed/pending; snoozed branch;
  pending branch (lazy create); no-workout case; ad-hoc exercise count
  from logs; timezone day-boundary case (user TZ ahead of UTC flips
  `is_today` and the store date arg); ListGroups error propagation;
  CreateSession error wrapped as `*CreateSessionError`; active-read error
  swallowed (falls through to snoozed)
- [x] run `go test ./internal/domain/workout ./internal/server` then
  `go test ./...` — must pass before task 3

### Task 3: Extract session listing + details into the service

- [x] add `ListSessions(userID int64, limit int) ([]SessionView, error)`
  in `internal/domain/workout/sessions.go` moving the group/variant
  enrichment out of `handleListWorkoutSessions`; `SessionView` json tags
  reproduce the current array element shape (`session`, `group_name`,
  `variant_name`, `exercises_count`, `exercises_completed`,
  `total_volume`). ⚠️ Scope note: the discovery description listed "date
  filtering, status parsing, rotation enrichment" but the actual handler
  does none of those — it only reads `?limit` (default 30) then enriches
  group/variant names + ad-hoc biggest-volume-variant + completed count +
  total volume. Implemented exactly what the handler does; `ListSessions`
  takes only `limit`. The empty-history result is a non-nil `[]SessionView{}`
  so it marshals to `[]`, matching the legacy `make(..., 0, …)`.
- [x] add `GetSessionDetails(sessionID int64) (*SessionDetails, error)`
  moving the session+logs load out of `handleGetSessionDetails`. Returns
  `(nil, nil)` for a missing/unreadable session (handler maps to 404,
  matching the legacy `err != nil || session == nil` branch); a non-nil
  error is reserved for a logs-read failure (handler 500).
- [x] shrink both handlers to parse → service → encode
- [x] write table-driven tests in `internal/domain/workout/sessions_test.go`
  (with an embedded `noopWorkoutStore` base + `fakeSessionStore`): empty
  history → non-nil `[]`; history error propagation; regular enrichment
  (group/variant names, exercise count from variant, completed count,
  total volume); group/variant missing → "Unknown" fallback; ad-hoc
  variant = biggest completed exercise by volume + count from logs;
  ad-hoc bodyweight uses sets*reps proxy for best-name (total_volume stays
  0); empty ad-hoc blank variant; GetSessionDetails found / not-found
  (nil→nil) / GetSession-error-as-not-found / logs-error propagation
- [x] run `go test ./...` — must pass before task 4

### Task 4: Extract stats + rotation reads into the service

- [x] add `GetStats(userID int64) (*Stats, error)` in
  `internal/domain/workout/stats.go` moving the 30-day counts, completion
  rate, 12-week activity heatmap, and top-exercises computation out of
  `handleGetWorkoutStats`. ⚠️ Scope note: the discovery description listed
  "filter + volume / sessions-per-week / percentile computations" but the
  actual handler does none of those — no `?` filters, no percentiles, no
  per-session volume. It reads up to 500 history rows, buckets the last 12
  weeks by ISO Monday, counts the last 30 days, and reads `ListExerciseStats`.
  Implemented exactly that; `GetStats` takes only `userID`. Two nil-vs-empty
  distinctions are load-bearing and preserved: `weekly_activity` stays nil
  (marshals to `null`, matching the legacy `var weeklyActivity []WeekActivity`)
  when no week is in range, and `top_exercises` is the raw `ListExerciseStats`
  result whose read error is swallowed (legacy `exerciseStats, _ := …`) so a
  failed read also marshals to `null`. Day-window cutoffs now come from the
  service's injectable `Now` clock (legacy called `time.Now()` inline twice),
  making the windows testable.
- [x] add `GetRotationState(groupID int64) (*store.WorkoutRotationState, error)`
  and `InitializeRotation(groupID, startingVariantID int64) error` in
  `internal/domain/workout/rotation.go`. ⚠️ Scope note: the discovery
  description said "merging/init logic" but the handlers were already
  near-thin store pass-throughs; moving them in still satisfies the Task 7
  "no direct `s.workouts.*` outside trivial CRUD" criterion. `GetRotationState`
  swallows a read error to `(nil, nil)` so the handler keeps its
  "err != nil || state == nil" → 404 branch; `InitializeRotation` keeps the
  `startingVariantID` parameter the store requires (the plan's earlier
  one-arg signature was a typo).
- [x] shrink the three handlers to thin form (parse → service → encode);
  removed the now-unused `sort` and `store` imports from `workout_handlers.go`
- [x] write table-driven tests in `internal/domain/workout/stats_test.go`
  and `rotation_test.go` (embedding `noopWorkoutStore`): stats zero sessions
  (asserts nil `weekly_activity`/`top_exercises`); history error propagation;
  mixed statuses inside the 30-day window (non-terminal `started` ignored,
  out-of-window row excluded, completion rate); per-week bucketing across the
  May/June month boundary (two same-week sessions share the Monday key,
  chronological sort, `active_weeks` excludes skip-only weeks); top-exercises
  passthrough + read-error swallowed; rotation state found / non-rotating
  group (nil→nil) / store-error-swallowed; initialize forwards args /
  idempotent re-init / error propagation
- [x] run `go test ./...` — must pass before task 5

### Task 5: Extract session state transitions into the service

All new code lives in `internal/domain/workout/transitions.go` (+
`transitions_test.go`); the `WorkoutStore` interface grew by 3 already-present
store methods (`UpdateSessionStatus`, `PreSkipSession`, `CancelPreSkip`) and the
`WorkoutService` interface by 4 methods. ⚠️ Signature note: `SetSessionStatus`
returns `(*Outcome, error)` (pointer), not the value `(Outcome, error)` the
plan sketched — a nil `*Outcome` with a nil error is the "session not found"
signal (handler → 404), mirroring the `(nil, nil)` convention `GetSessionDetails`
already uses. `Outcome` carries the pre-transition `Session` (for the
notification message id) and a `Terminal` bool (skipped/completed → run cleanup).

- [x] add `SetSessionStatus(sessionID int64, status string) (*Outcome, error)`
  moving the transition rules + rotation advancement out of
  `handleUpdateSessionStatus`; the returned `Outcome` tells
  the handler whether to fire the completion notification — notification
  dispatch itself stays in the handler. Invalid status → sentinel
  `ErrInvalidSessionStatus` (handler 400); missing session → `(nil, nil)`
  (handler 404). Reuses `SkipSession`/`CompleteSession` for the terminal
  branches (so rotation advances) and a plain `UpdateSessionStatus` for
  `in_progress`, matching the pre-extraction handler. `handleUpdateSessionStatus`
  has no ownership check (it never did), so `SetSessionStatus` takes no userID.
- [x] move pre-skip state management out of `handlePreSkipWorkoutSession`
  / `handleCancelPreSkipWorkoutSession` into `PreSkipSession` /
  `CancelPreSkipSession`. Per the file's existing Snooze convention the
  ownership/existence `GetSession` stays in the handler (now annotated as an
  auth guard for Task 7's grep); the state transition routes through the service.
- [x] move variant-selection logic out of `handleNextVariantWorkoutSession`
  into `NextVariant(sessionID int64)` — status/group/rotation checks return
  sentinel errors (`ErrSessionNotFound`, `ErrVariantChangeNotAllowed`,
  `ErrGroupNotFound`, `ErrGroupNotRotating`) the handler maps to the exact
  400/404 responses the old handler produced. Ownership `GetSession` stays in
  the handler (auth guard); `NextVariant` re-reads the row for its
  status/group checks (a harmless second idempotent read — behavior-preserving).
- [x] residual state logic in `handleSnoozeWorkoutSession` /
  `handleStartWorkoutSession`: nothing left to move — both already route their
  only state mutation through the existing `SnoozeSession` / `StartSession`
  service methods (`StartSession` also does the `ClearSnooze`). Their remaining
  `s.workouts.*` calls are read-only (ownership guard / notification-text reads),
  not state mutations. No change needed.
- [x] write tests in `transitions_test.go` (fake embeds `noopWorkoutStore`):
  SetSessionStatus invalid-status / not-found (missing + read-error) /
  in_progress plain update / skipped-advances-rotation / completed-non-rotating /
  skip-error propagation; PreSkip + CancelPreSkip forward + error propagation;
  NextVariant happy path + each rejection sentinel + advance/delete error
  propagation. Existing `internal/server` handler tests
  (`TestHandleUpdateSessionStatus`, `…_CleansUpWorkoutChatOnTerminalState`) pass
  unmodified.
- [x] run `go test ./...` — passes (exit 0, 38 packages); both build modes
  (`go build ./...`, `go build -tags mobile ./...`) and `go vet` clean.

### Task 6: Extract exercise-log writes into the service

- [ ] move validation + schedule-field merging out of
  `handleAddExerciseToSession` (1277–1384) into
  `AddExerciseToSession(sessionID int64, …) (…, error)`
- [ ] move validation, state transitions, and timestamp handling out of
  `handleUpdateExerciseLog` (1136–1222) into `UpdateExerciseLog(…)`
- [ ] map service validation errors to the same HTTP status codes the
  handlers return today (follow the existing `ErrScheduleInPast` →
  400 pattern with sentinel errors)
- [ ] write tests: add-to-session with library vs ad-hoc exercise,
  invalid input rejection, update-log status transitions, timestamp
  normalization
- [ ] run `go test ./...` — must pass before task 7

### Task 7: Verify acceptance criteria

- [ ] every handler in `workout_handlers.go` is thin: no direct
  `s.workouts.*` calls except in trivial CRUD handlers that were already
  thin (group/variant/exercise/library CRUD + deletes); grep
  `s\.workouts\.` and justify each remaining hit in a code comment or
  move it
- [ ] `wc -l internal/server/workout_handlers.go` is under ~900 lines
- [ ] no JSON contract drift: existing `internal/server` workout handler
  tests pass unmodified
- [ ] both build modes compile: `go build ./...` and `go build -tags mobile ./...`
- [ ] run full test suite: `go test ./...` and `pnpm test`
- [ ] run linter (`go vet ./...` + project linter if configured) — all
  issues fixed

### Task 8: [Final] Update documentation

- [ ] update CLAUDE.md: Code Layout entry for `internal/workout` →
  `internal/domain/workout`; "Modifying workout rotation" section paths
- [ ] update `docs/architecture.md` domain-service-pattern section: the
  reference service path, and note that workout read models
  (GetNext/Stats/ListSessions) live in the service
- [ ] grep docs/ for `internal/workout` and fix remaining references

## Technical Details

- **Service struct shape**: keep the existing pattern —
  `Service{store WorkoutStore, tz TZStore, Now func() time.Time}`. The
  new read methods reuse `tz`/`Now` for day-boundary math, which makes
  the timezone behavior testable for the first time (today
  `handleGetNextWorkout` calls `time.Now()` inline).
- **Response structs over maps**: each extracted method returns a named
  struct with json tags replicating the current anonymous-struct/map
  output. Verify with the existing handler tests; where a shape isn't
  covered by a test, add a handler-level test asserting the exact JSON
  keys *before* extracting (still behavior-preserving — it pins current
  behavior).
- **Store interface growth**: `WorkoutStore` grows by ~12 read methods.
  That's acceptable — it remains the service's own minimal interface;
  the fake store in tests implements only what each test needs via
  embedded no-op base.
- **MCP registry**: untouched. Routes and shapes don't change, so
  `operations_workouts.go` and the coverage guard need no edits.

## Post-Completion

**Manual verification**:
- Open the Workouts section in the web UI: next-workout card, session
  list, history stats all render identically.
- Trigger a workout notification via the bot and complete a session —
  rotation advances, completion notification arrives.

**External system updates**: none — routes and payloads are unchanged.
