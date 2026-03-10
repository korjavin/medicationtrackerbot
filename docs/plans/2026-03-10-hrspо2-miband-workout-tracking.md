---
# HR/SpO2 Tracking from Mi Band Workouts

## Overview
Add SpO2 to the Mi Notify external endpoint, display SpO2 in workout history cards, overlay Mi Band HR/SpO2 data on matching manual strength session cards (client-side ±2h window), provide a bulk import endpoint for offline backups, and expose SpO2 + time-matched HR data through MCP.

## Context
- Files involved:
  - `internal/server/external_workout_handlers.go` — Mi Notify inbound payload (missing SpO2)
  - `internal/server/external_workout_handlers_test.go` — existing tests
  - `internal/server/server.go` — route registration
  - `web/static/js/workout.js` — history rendering, card builders
  - `web/static/index.html` — modals
  - `internal/mcp/tools.go` — WorkoutSessionResult type, get_workout_history handler
- Related patterns: `miband_workouts` table already has `spo2_avg`; edit modal already has SpO2 input; store methods already support SpO2; MCP already returns `HeartRateAvg` for Mi Band results
- Dependencies: none new

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add SpO2 to external workout endpoint

**Files:**
- Modify: `internal/server/external_workout_handlers.go`
- Modify: `internal/server/external_workout_handlers_test.go`

- [ ] Add `SpO2 int` field (`json:"spo2"`) to `miNotifyPayload` struct
- [ ] Set `SpO2Avg: payload.SpO2` when constructing `store.MiBandWorkout`
- [ ] Add test case: POST with `spo2: 97`, verify stored value via mock
- [ ] Run `go test ./internal/server` — must pass before task 2

### Task 2: Display SpO2 chip in Mi Band workout card

**Files:**
- Modify: `web/static/js/workout.js`

- [ ] In `_buildMiBandCard()`, after the HR chip line (`if (w.heart_rate_avg > 0)`), add: `if (w.spo2_avg > 0) chips.push('🩸 ' + w.spo2_avg + '%');`
- [ ] Manual test: verify SpO2 appears on card when data is present
- [ ] (No backend test needed — UI-only change)

### Task 3: Overlay Mi Band HR/SpO2 on manual session cards (client-side ±2h matching)

**Files:**
- Modify: `web/static/js/workout.js`

- [ ] In `_renderWorkoutHistory()`, after building the `items` array and sorting, build a lookup: for each manual session item, find any Mi Band workout where `|miband.ts - session.ts| <= 2 * 3600 * 1000`; attach matched workout as `item.mibandMatch`
- [ ] Modify the `forEach` dispatch loop to pass `item.mibandMatch` to `_buildSessionCard(s, mibandMatch)`
- [ ] In `_buildSessionCard(s, mibandMatch)`, if `mibandMatch` is provided and has `heart_rate_avg > 0` or `spo2_avg > 0`, append small HR/SpO2 chips to the `details` element (same style as volume text, prefixed with `❤️`/`🩸`)
- [ ] Manual test: create a manual session and a Mi Band workout within 2h; verify HR/SpO2 shows on the session card

### Task 4: Bulk import endpoint + import UI for offline backup

**Files:**
- Modify: `internal/server/external_workout_handlers.go`
- Modify: `internal/server/server.go`
- Modify: `web/static/index.html`
- Modify: `web/static/js/workout.js`

- [ ] Add `handleBulkImportWorkouts` handler that: reads body as `[]miNotifyPayload`, applies same timestamp conversion + deduplication logic as `handleExternalWorkout`, inserts each record, returns `{"imported": N, "duplicates": M, "errors": K}`
- [ ] Register route: `POST /api/workout/miband/import` in `apiMux` (Telegram-authenticated section) in `server.go`
- [ ] Add an `<mt-modal id="miband-import-modal">` to `index.html` with a `<textarea>` for JSON paste and a submit button
- [ ] Add "Import" button near the workout history header in `index.html`
- [ ] In `workout.js`, add `openMiBandImportModal()` and `submitMiBandImport()` functions; call `loadWorkoutHistoryTab()` on success
- [ ] Add test: POST array of 3 workouts (2 new, 1 duplicate), verify counts
- [ ] Run `go test ./internal/server` — must pass before task 5

### Task 5: MCP — add SpO2 and server-side time matching for manual sessions

**Files:**
- Modify: `internal/mcp/tools.go`

- [ ] Add `SpO2Avg *int` field to `WorkoutSessionResult` struct
- [ ] Populate `SpO2Avg` when building Mi Band results (alongside existing `HeartRateAvg`)
- [ ] After building all results, for each `manual` result with a known start timestamp, find any `miband` result within ±2h; if matched, populate the manual result's `HeartRateAvg` and `SpO2Avg` from the Mi Band record (if not already set)
- [ ] Add or update test in `internal/mcp/` verifying SpO2 appears in response for a Mi Band workout
- [ ] Run `go test ./internal/mcp` — must pass before task 6

### Task 6: Verify acceptance criteria

- [ ] Manual test: configure Mi Notify to POST `{"workout_type":"strength","start_time":...,"heart_rate":145,"spo2":97,...}` and verify both fields appear in workout history
- [ ] Manual test: paste JSON array into import modal, verify import count
- [ ] Manual test: verify manual session card shows HR/SpO2 from a same-day Mi Band workout
- [ ] Manual test: query MCP `get_workout_history` and verify SpO2 field present for Mi Band workouts and HR/SpO2 reflected on matched manual session
- [ ] Run `go test ./...` — all tests pass
- [ ] Run `go vet ./...`

### Task 7: Update documentation

- [ ] Update `CLAUDE.md` environment variables section if any new env var added (none expected)
- [ ] Move this plan to `docs/plans/completed/`
