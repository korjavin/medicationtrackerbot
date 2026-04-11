# BP Averaging Hardening

## Overview
Validate, harden, and document the BP daily-weighted averaging algorithm in `GetBPDailyWeightedStats`. The algorithm already uses a correct two-stage approach (per-day time-weighted → equal-weight per day across period), but needs:

1. **Timezone fix**: Day boundaries use UTC instead of the user's stored timezone, causing incorrect day splits for readings near midnight local time
2. **Scenario tests**: No tests cover the real-world pattern of frequent high-BP measurements vs sparse normal-day measurements
3. **Algorithm documentation**: The weighting logic is non-obvious and deserves clear inline documentation

**Bug**: `truncateToDayUTC()` splits readings into UTC days. A user in Europe/Berlin measuring at 00:30 local (22:30 UTC in summer) has that reading assigned to the *previous* UTC day. This corrupts per-day averages.

**Algorithm summary** (already implemented, needs documentation):
- Stage 1: Within each day, weight each reading by duration until next reading (or end-of-day/now). Compute time-weighted daily average.
- Stage 2: Average daily averages across the period. Each day with data = 1 equal vote, regardless of reading count. This prevents measurement-frequency bias.

## Context
- Core algorithm: `internal/store/store.go:1096-1221` — `GetBPDailyWeightedStats()`
- Day truncation: `internal/store/store.go:1223-1226` — `truncateToDayUTC()`
- Existing tests: `internal/store/bp_stats_test.go` — 6 test cases
- User timezone: `store.GetCurrentTimezone()` returns IANA timezone string from `timezone_history` table
- API handler: `internal/server/bp_handlers.go:250-263` — `handleGetBPStats()`
- The function uses `nowFunc` for testability (injectable clock)

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility — existing API response format unchanged

## Testing Strategy
- **Unit tests**: All in `internal/store/bp_stats_test.go`
- Tests use in-memory SQLite (`:memory:`) and injectable `nowFunc`
- For timezone tests: insert timezone into `timezone_history` table, then verify day boundaries respect it

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Add scenario-specific tests for existing algorithm
- [x] Add test `TestBPStats_FrequentHighBPDayVsSparseNormal`: 3 normal days with 1 reading each (120/80), 1 high-BP day with 5 readings (150/95 area), verify period average is close to 127 (not inflated by the 5 readings)
- [x] Add test `TestBPStats_SingleReadingPerDay`: 5 days each with exactly 1 reading at different times, verify each day's average equals its single reading value
- [x] Add test `TestBPStats_LongGapBetweenDays`: readings on day 1 and day 10 only, verify both days contribute equally to the 14-day average
- [x] Add test `TestBPStats_ManyReadingsInShortBurst`: 10 readings within 30 minutes on one day, 1 reading on another day, verify the burst day doesn't dominate
- [x] Run `go test ./internal/store/...` — must pass before next task

### Task 2: Fix day boundary to use user timezone
- [x] Add a `truncateToDay(t time.Time, loc *time.Location) time.Time` function that truncates to day start in the given timezone (replaces UTC-only truncation)
- [x] Modify `GetBPDailyWeightedStats` to accept a `*time.Location` parameter (or load timezone inside the function via `s.GetCurrentTimezone()`)
- [x] Update `truncateToDayUTC` calls within the function to use `truncateToDay(t, loc)` instead
- [x] Fall back to UTC when no timezone is stored (backward compatible)
- [x] Update `handleGetBPStats` in `bp_handlers.go` to pass the timezone (or let the store function load it internally)
- [x] Write test `TestBPStats_TimezoneAwareDayBoundary`: user in "Asia/Tokyo" (UTC+9), readings at 23:30 and 00:30 local time should be on different local days (same UTC day)
- [x] Write test `TestBPStats_NoTimezoneFallsBackToUTC`: no timezone stored, verify behavior matches current UTC-based logic
- [x] Verify all existing 6 tests still pass (they use UTC implicitly, should be unchanged with UTC fallback)
- [x] Run `go test ./internal/store/...` — must pass before next task

### Task 3: Add algorithm documentation
- [ ] Add block comment above `GetBPDailyWeightedStats` explaining the two-stage algorithm, why each day gets equal weight, and how measurement-frequency bias is mitigated
- [ ] Add inline comments at key points: day aggregation loop, same-timestamp skip, day-boundary capping, period averaging
- [ ] Document the timezone-aware day truncation behavior
- [ ] Run `go test ./...` — must pass before next task

### Task 4: Verify acceptance criteria
- [ ] Verify all new tests pass and cover the user's real-world scenarios
- [ ] Verify timezone fix works for non-UTC timezones
- [ ] Verify UTC fallback preserves backward compatibility
- [ ] Run full test suite (`go test ./...`)
- [ ] Run `go vet ./...`
- [ ] Verify existing BP stats API response format unchanged

### Task 5: [Final] Update documentation
- [ ] Update CLAUDE.md if needed (mention timezone-aware BP averaging)

## Technical Details

### Current day truncation (UTC only)
```go
func truncateToDayUTC(t time.Time) time.Time {
    utc := t.UTC()
    return time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
}
```

### Proposed timezone-aware truncation
```go
func truncateToDay(t time.Time, loc *time.Location) time.Time {
    local := t.In(loc)
    return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
}
```

### Timezone loading in GetBPDailyWeightedStats
```go
func (s *Store) GetBPDailyWeightedStats(ctx context.Context, userID int64) (*BPStats, error) {
    loc := time.UTC // default fallback
    if tzStr, err := s.GetCurrentTimezone(); err == nil && tzStr != "" {
        if parsed, err := time.LoadLocation(tzStr); err == nil {
            loc = parsed
        }
    }
    // ... rest of algorithm using truncateToDay(t, loc) ...
}
```

### Frequency bias example (validates current algorithm is correct)
```
14-day period:
- Days 1-3: 1 reading/day at 120/80 → daily avg = 120/80
- Day 4: 5 readings (150, 148, 145, 142, 140) over 2 hours → daily avg ≈ 145/90
- Days 5-14: no measurements

Naive mean of 8 readings: (3×120 + 5×145) / 8 = 135.6
Daily-weighted mean of 4 days: (3×120 + 1×145) / 4 = 126.3  ← correct, fair
```

## Post-Completion

**Manual verification:**
- Check that BP averages displayed in the app match expectations for your real data
- Verify the "(Xd)" count in the display still reflects days with actual readings
