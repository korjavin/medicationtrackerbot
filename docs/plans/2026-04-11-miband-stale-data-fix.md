# Mi Band Stale Data Fix

## Overview
When a Mi Band backup is sent mid-day, partial data (e.g., 2000 steps at 09:00) is imported. When the same backup is sent later with complete data (8000 steps at 18:00), the import is silently ignored because all three affected tables use `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`.

**Bug:** Sleep graphs and step graphs show lower values than the Mi Band app because mid-day snapshots are never updated by subsequent imports.

**Fix:** Change `INSERT OR IGNORE` / `DO NOTHING` to `ON CONFLICT DO UPDATE` (UPSERT) for:
1. `day_stats` — always overwrite with newer step/calorie/distance values
2. `sleep_logs` — update only if new `total_minutes > existing` (more complete data)
3. `miband_workouts` — update mutable fields (steps, calories, distance, duration, HR, SpO2)

Vitals tables (`vitals_heart`, `vitals_spo2`, `vitals_stress`) use millisecond-precision timestamps and are not affected — each reading is naturally unique.

## Context
- `internal/store/store.go:1390-1445` — `ImportSleepLogs()`: `INSERT OR IGNORE` with `UNIQUE(user_id, start_time)`
- `internal/store/store.go:1447-1479` — `ImportDayStats()`: `INSERT OR IGNORE` with `UNIQUE(user_id, day)`
- `internal/store/miband_workouts.go:57-92` — `InsertMiBandWorkout()`: `ON CONFLICT(user_id, source_start_ms) DO NOTHING`
- `internal/store/miband_workouts.go:97-200` — `ImportMiBandWorkouts()`: same `DO NOTHING` pattern
- Existing tests: `internal/store/store_miband_test.go`, `internal/store/store_sleep_vitals_test.go`
- Bot import flow: `internal/bot/sleep_import.go` calls all three import functions

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Backend-only changes — no frontend or API modifications

## Testing Strategy
- **Unit tests**: in-memory SQLite (`:memory:`) in `internal/store/`
- Test pattern: insert partial data → import again with complete data → verify values updated
- Verify existing tests still pass (they rely on `INSERT OR IGNORE` for dedup — need to verify that "truly duplicate" data still doesn't create extra rows)

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Fix ImportDayStats to UPSERT
- [x] In `ImportDayStats()` (`store.go:1455-1457`), change SQL from:
  ```sql
  INSERT OR IGNORE INTO day_stats (user_id, day, steps, calories, distance) VALUES (?, ?, ?, ?, ?)
  ```
  to:
  ```sql
  INSERT INTO day_stats (user_id, day, steps, calories, distance) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, day) DO UPDATE SET steps=excluded.steps, calories=excluded.calories, distance=excluded.distance
  ```
- [x] Update the `imported`/`skipped` counting logic: `RowsAffected()` returns 1 for both INSERT and UPDATE with SQLite UPSERT, so track "updated" separately if needed, or accept that `imported` now includes updates
- [x] Write test: insert day_stats with steps=2000, import again with steps=8000, verify steps=8000 in DB
- [x] Write test: import same data twice, verify no duplicate rows created
- [x] Write test: import two different days, verify both exist independently
- [x] Run `go test ./internal/store/...` — must pass before next task

### Task 2: Fix ImportSleepLogs to conditionally UPSERT
- [x] In `ImportSleepLogs()` (`store.go:1412-1428`), change SQL from:
  ```sql
  INSERT OR IGNORE INTO sleep_logs (...) VALUES (...)
  ```
  to:
  ```sql
  INSERT INTO sleep_logs (...) VALUES (...)
  ON CONFLICT(user_id, start_time) DO UPDATE SET
    end_time=excluded.end_time,
    light_minutes=excluded.light_minutes,
    deep_minutes=excluded.deep_minutes,
    rem_minutes=excluded.rem_minutes,
    awake_minutes=excluded.awake_minutes,
    total_minutes=excluded.total_minutes,
    turn_over_count=excluded.turn_over_count,
    heart_rate_avg=excluded.heart_rate_avg,
    spo2_avg=excluded.spo2_avg
  WHERE excluded.total_minutes > sleep_logs.total_minutes
  ```
  The `WHERE` clause ensures only more-complete data overwrites existing rows
- [x] Do NOT update `user_modified` or `notes` — those are user-editable fields
- [x] Write test: insert sleep log with total_minutes=120, import again with total_minutes=480, verify updated to 480
- [x] Write test: insert sleep log with total_minutes=480, import again with total_minutes=120, verify NOT downgraded (stays 480)
- [x] Write test: import identical sleep data twice, verify single row, no duplicate
- [x] Run `go test ./internal/store/...` — must pass before next task

### Task 3: Fix InsertMiBandWorkout and ImportMiBandWorkouts to UPSERT
- [x] In `InsertMiBandWorkout()` (`miband_workouts.go:62-68`), change SQL from:
  ```sql
  ON CONFLICT(user_id, source_start_ms) DO NOTHING
  ```
  to:
  ```sql
  ON CONFLICT(user_id, source_start_ms) DO UPDATE SET
    source_end_ms=excluded.source_end_ms,
    duration_sec=excluded.duration_sec,
    distance_m=excluded.distance_m,
    steps=excluded.steps,
    calories=excluded.calories,
    heart_rate_avg=excluded.heart_rate_avg,
    spo2_avg=excluded.spo2_avg,
    pause_ms=excluded.pause_ms
  ```
- [x] Apply the same UPSERT change to `ImportMiBandWorkouts()` (`miband_workouts.go:113-119`)
- [x] For `InsertMiBandWorkout()`: when UPSERT updates (rowsAffected=1 but no new ID), handle the `LastInsertId()` case — it may return the existing row's ID or 0; verify behavior
- [x] For `ImportMiBandWorkouts()`: when UPSERT updates an existing row, skip GPS track re-insertion (GPS points are immutable from the device, no need to re-import)
- [x] Update `handleExternalWorkout()` in `external_workout_handlers.go`: the fuzzy duplicate check (~line 109) should still work, but verify that the "duplicate" response now reflects "updated" vs "truly duplicate" semantics
- [x] Write test: insert workout with steps=1000, import again with steps=5000, verify updated
- [x] Write test: import same workout twice with identical data, verify single row
- [x] Write test: verify GPS tracks are not duplicated on re-import
- [x] Run `go test ./internal/store/...` — must pass before next task

### Task 4: Verify acceptance criteria
- [ ] Verify all three import functions update stale data on re-import
- [ ] Verify sleep logs only update when new data has higher total_minutes
- [ ] Verify no duplicate rows are created in any table
- [ ] Verify GPS tracks are not duplicated
- [ ] Verify existing tests still pass (dedup behavior preserved for truly identical data)
- [ ] Run full test suite (`go test ./...`)
- [ ] Run `go vet ./...`

### Task 5: [Final] Update documentation
- [ ] Update CLAUDE.md import section if needed

## Technical Details

### SQLite UPSERT behavior
- `ON CONFLICT DO UPDATE` returns `RowsAffected()=1` for both INSERT and UPDATE
- `LastInsertId()` returns the rowid of the inserted/updated row
- The `excluded` pseudo-table refers to the values that would have been inserted
- `WHERE` clause on `DO UPDATE` makes the update conditional — if the condition is false, the conflicting INSERT is silently ignored (no error, rowsAffected=0)

### Import return value semantics change
Currently: `(imported, skipped, error)` where `imported` = new rows, `skipped` = conflicts
After fix: `imported` includes both new inserts AND updates. `skipped` only counts rows where the conditional WHERE prevented an update. This is acceptable — the caller (bot import) just displays "imported X, skipped Y" in a message.

## Post-Completion

**Manual verification:**
- Send an NXK backup mid-day, note step count in the app
- Send the same backup again at end of day
- Verify step count updated in the app's Health tab
- Compare sleep graph with Mi Band app for the same period
