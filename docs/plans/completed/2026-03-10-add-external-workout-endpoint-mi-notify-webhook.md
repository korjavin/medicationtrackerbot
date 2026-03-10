# Add External Workout Endpoint (Mi Notify Webhook)

## Overview
Add `POST /api/workout/external` endpoint that accepts workout data from Mi Notify (and similar apps) using static API key authentication. The endpoint stores data in the existing `miband_workouts` table, logs all incoming payloads for debugging, and sends a Telegram/WebPush notification on success.

## Context
- Files involved:
  - `internal/store/miband_workouts.go` - add `InsertMiBandWorkout` store method
  - `internal/store/store_miband_test.go` - add store test
  - `internal/server/store_interfaces.go` - add `InsertMiBandWorkout` to `MiBandStore` interface
  - `internal/server/server.go` - add `externalAPIKey` field, load from env in `New()`
  - `internal/server/external_workout_handlers.go` - new file for handler
  - `internal/server/external_workout_handlers_test.go` - new file for handler test
  - `.env.example` or `README.md` - document new env var
- Related patterns:
  - Existing `ImportMiBandWorkouts` for dedup by `(user_id, source_start_ms)`
  - `s.notify()` helper in `server.go` for multi-channel notifications
  - `rateLimitMiddleware` / `AuthMiddleware` for middleware patterns
  - Route registration in `Routes()` - external route registered on main mux before Telegram auth wraps `/api/`

## Development Approach
- **Testing approach**: Regular (code first, tests after)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add `InsertMiBandWorkout` to store

**Files:**
- Modify: `internal/store/miband_workouts.go`
- Modify: `internal/store/store_miband_test.go`

- [ ] Add `InsertMiBandWorkout(ctx context.Context, w MiBandWorkout) (inserted bool, err error)` to `miband_workouts.go`; does `INSERT OR IGNORE INTO miband_workouts ...` and returns `inserted=true` if a new row was created (check `RowsAffected`), `inserted=false` if dedup skipped
- [ ] Write test `TestInsertMiBandWorkout` covering: successful insert, dedup (same user_id + source_start_ms inserts once), field round-trip
- [ ] Run `go test ./internal/store` — must pass

### Task 2: Add method to server interface and wire API key

**Files:**
- Modify: `internal/server/store_interfaces.go`
- Modify: `internal/server/server.go`

- [ ] Add `InsertMiBandWorkout(ctx context.Context, w store.MiBandWorkout) (bool, error)` to `MiBandStore` interface in `store_interfaces.go`
- [ ] Add `externalAPIKey string` field to `Server` struct in `server.go`
- [ ] In `New()`, read `os.Getenv("EXTERNAL_WORKOUT_API_KEY")` and assign to `srv.externalAPIKey`; if empty, log a warning that the external endpoint will reject all requests
- [ ] Run `go build ./...` to verify interface compliance

### Task 3: Implement external workout handler

**Files:**
- Create: `internal/server/external_workout_handlers.go`

- [ ] Define `miNotifyPayload` struct with JSON tags: `WorkoutType string`, `StartTime int64`, `EndTime int64`, `Calories int`, `Distance float64`, `HeartRate int`, `Steps int` — all fields optional except `WorkoutType` and `StartTime`
- [ ] Add helper `externalAPIKeyMiddleware(next http.HandlerFunc) http.HandlerFunc` on `*Server`: reads `Authorization` header, accepts `Bearer <key>` or bare `<key>`, compares to `s.externalAPIKey`; returns 401 if missing/wrong
- [ ] Implement `handleExternalWorkout(w, r)`:
  - Read and log raw request body (`log.Printf("[external-workout] raw body: %s", body)`) before any parsing
  - Parse JSON into `miNotifyPayload`; on error, log full error + raw body, return 400
  - Validate required fields (`WorkoutType`, `StartTime > 0`); log and return 400 if missing
  - Detect timestamp unit: if `StartTime > 1e12` treat as milliseconds, else multiply by 1000
  - Build `store.MiBandWorkout` with `UserID = s.allowedUserID`, compute `DurationSec` from end-start, `DistanceM = payload.Distance`, etc.; set `ActivityName = payload.WorkoutType`, `ActivityType = 0` (unknown)
  - Call `s.miband.InsertMiBandWorkout(r.Context(), workout)`; on error log and return 500
  - If `inserted=false` (duplicate), log and return 200 with `{"status":"duplicate"}`
  - Call `s.notify()` with a message like `"Workout recorded: {type} ({duration} min)"`
  - Return 200 with `{"status":"ok", "id": <inserted_id>}`

### Task 4: Register route

**Files:**
- Modify: `internal/server/server.go` in `Routes()`

- [ ] Register `mux.HandleFunc("POST /api/workout/external", s.externalAPIKeyMiddleware(s.handleExternalWorkout))` on the main `mux` BEFORE `mux.Handle("/api/", authMW(apiMux))` so the specific path takes precedence over the Telegram auth catch-all
- [ ] Run `go build ./...` to confirm

### Task 5: Tests for handler

**Files:**
- Create: `internal/server/external_workout_handlers_test.go`

- [ ] Write `TestHandleExternalWorkout` with table-driven cases:
  - Missing API key → 401
  - Wrong API key → 401
  - Valid key, valid payload → 200 `{"status":"ok"}`
  - Valid key, duplicate payload → 200 `{"status":"duplicate"}`
  - Valid key, malformed JSON → 400
  - Valid key, missing `WorkoutType` → 400
  - Valid key, timestamp in seconds → correct `source_start_ms` in store
- [ ] Use in-memory store mock (implement `MiBandStore` inline) as per project testing pattern
- [ ] Run `go test ./internal/server` — must pass

### Task 6: Verify acceptance criteria

- [ ] Manual test: `curl -X POST http://localhost:8080/api/workout/external -H "Authorization: Bearer testkey" -H "Content-Type: application/json" -d '{"workout_type":"running","start_time":1700000000,"end_time":1700003600,"calories":350,"distance":5000,"heart_rate":145,"steps":6000}'` — returns 200
- [ ] Verify workout appears in Mi Band workouts list in the UI
- [ ] Verify TG/WebPush notification was sent
- [ ] Run full test suite: `go test ./...`
- [ ] Run linter: `go vet ./...`

### Task 7: Update documentation

- [ ] Add `EXTERNAL_WORKOUT_API_KEY` to `.env.example` or README environment variables section
- [ ] Update `CLAUDE.md` environment variables section to document the new key
- [ ] Move this plan to `docs/plans/completed/`
