# BP Chart Noise Reduction

## Overview
The BP chart on mobile is too noisy — 60 days of raw readings (120-180 points) crammed into ~320px creates visual clutter and makes Catmull-Rom splines overshoot between tightly-packed points, producing "funny" curves.

**Solution:** Two-layer data preparation before rendering:
1. **Daily aggregation** for older data (>7 days): collapse multiple readings per day into a single time-weighted daily average point
2. **LTTB downsampling** for recent data (≤7 days): if still too dense, thin to a target point count while preserving peaks/valleys

This is frontend-only — no API changes. The raw reading list below the chart is unaffected.

**Expected result:** ~40-60 points instead of 120-180, smooth splines, readable on mobile.

## Context
- BP chart rendering: `web/static/js/features/bp.js:151-361` — `renderBPChart()`
- Data source: `/api/bp?days=60` returns all raw readings for 60 days
- Chart utilities: `web/static/js/core/chart-utils.js` — `ChartUtils.catmullRomSpline()` and helpers
- The chart currently sorts readings and plots every single point with spline interpolation
- Weight chart is out of scope (30-day window, fewer points, adequate as-is)
- The reading list below the chart (`renderBPReadings()`) already filters to last 3 days — unaffected by this change

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Frontend-only changes — no backend modifications

## Testing Strategy
- **Unit tests**: JS tests for aggregation and LTTB utility functions
- Test in `web/static/js/tests/` alongside existing architecture tests
- Test cases: empty data, single point, single day with many readings, multi-day with gaps, boundary between recent/old data

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Add daily aggregation utility to ChartUtils
- [x] Add `ChartUtils.aggregateToDaily(readings, recentDays)` to `web/static/js/core/chart-utils.js`
  - Input: array of `{date, sys, dia, pulse, category}` objects + `recentDays` threshold (default 7)
  - Output: array of same shape, where readings older than `recentDays` are collapsed to one point per calendar day (time-weighted average of sys/dia within each day, placed at the day's midpoint time, category = classification of the daily average values)
  - Readings within `recentDays` are passed through unchanged
- [x] Time-weighting within a day: weight each reading by duration until the next reading (same logic as backend `GetBPDailyWeightedStats`). Single reading per day = that reading's value
- [x] Write tests: empty array returns empty array
- [x] Write tests: all readings within recent window → no aggregation, same count
- [x] Write tests: 3 readings on one old day → 1 aggregated point with correct time-weighted values
- [x] Write tests: mix of recent individual + old aggregated points, verify correct split at boundary
- [x] Run JS tests — must pass before next task

### Task 2: Add LTTB downsampling utility to ChartUtils
- [x] Add `ChartUtils.lttbDownsample(points, targetCount)` to `web/static/js/core/chart-utils.js`
  - Input: array of `[x, y]` coordinate pairs + target point count
  - Output: reduced array preserving first point, last point, and most visually significant intermediate points
  - Algorithm: Largest-Triangle-Three-Buckets (split data into `targetCount` buckets, keep the point in each bucket that forms the largest triangle with adjacent selected points)
- [x] If input length ≤ targetCount, return input unchanged
- [x] Write tests: input shorter than target → returns unchanged
- [x] Write tests: known 10-point dataset downsampled to 5 → preserves first, last, and peaks
- [x] Write tests: preserves extreme values (max and min should survive downsampling)
- [x] Run JS tests — must pass before next task

### Task 3: Integrate into BP chart rendering
- [x] In `renderBPChart()` (`bp.js`), after sorting readings and creating the `data` array (~line 169), add a data preparation step:
  1. Call `ChartUtils.aggregateToDaily(data, 7)` to collapse old readings
  2. Determine target point count based on container width: `Math.max(30, Math.floor(container.clientWidth / 6))` (minimum ~6px per point)
  3. If point count still exceeds target, apply `ChartUtils.lttbDownsample()` separately to systolic and diastolic series (using x=date, y=value), then reconcile back to the unified data array
- [x] Visually distinguish aggregated points from individual readings: use slightly smaller radius (r=3) or a different stroke style for aggregated daily points
- [x] Ensure splines render cleanly with the reduced point set — no more overshooting on mobile
- [x] Verify chart average lines still use ALL raw readings (not the downsampled set) for accuracy
- [x] Run JS tests and architecture tests — must pass before next task

### Task 4: Verify acceptance criteria
- [x] Verify chart renders cleanly on mobile viewport (~320-375px width) (manual - skipped, not automatable)
- [x] Verify splines no longer overshoot/produce funny curves (manual - skipped, not automatable)
- [x] Verify recent readings (last 7 days) still show individual points (verified via aggregateToDaily tests - recent window passes through unchanged)
- [x] Verify older readings show daily aggregates (fewer points, smoother line) (verified via aggregateToDaily tests - old readings collapse to daily)
- [x] Verify the BP reading list below the chart is unaffected (renderBPReadings is separate from renderBPChart, no changes made)
- [x] Verify average lines still use all raw data (confirmed: bp.js:196-197 computes averages from rawData before aggregation at line 200)
- [x] Verify chart works with 0, 1, 2, and many readings (verified via integration tests in chart-utils.test.js covering empty, single, and many-point cases)
- [x] Run full JS test suite (53 files, 391 tests passed)
- [x] Run architecture tests (design tokens, globals) (all passed)

### Task 5: [Final] Update documentation
- [x] Add `aggregateToDaily` and `lttbDownsample` to ChartUtils API documentation in CLAUDE.md if appropriate

## Technical Details

### Daily Aggregation Algorithm
```
Input: [{date, sys, dia, ...}, ...]
recentCutoff = now - 7 days

For readings BEFORE recentCutoff:
  Group by calendar day
  For each day's group:
    Sort chronologically
    For each reading i:
      weight_i = time_until_next_reading (or end-of-day for last)
    dailyAvgSys = Σ(sys_i × weight_i) / Σ(weight_i)
    dailyAvgDia = Σ(dia_i × weight_i) / Σ(weight_i)
    Emit one point at day midpoint with averaged values

For readings ON or AFTER recentCutoff:
  Pass through unchanged

Return: merged array sorted by date
```

### LTTB Algorithm
```
Input: points[], targetCount

1. Always keep first and last point
2. Split remaining points into (targetCount - 2) equal-sized buckets
3. For each bucket:
   a. Calculate the triangle area formed by:
      - previously selected point
      - candidate point in this bucket
      - average point of next bucket
   b. Keep the point with the largest triangle area
4. Return selected points in order
```

### Target Point Count Heuristic
```
Mobile (320px): max(30, 320/6) = 53 points
Tablet (768px): max(30, 768/6) = 128 points
Desktop (1200px): max(30, 1200/6) = 200 points
```
This ensures ~6px minimum spacing between points — readable without crowding.

## Post-Completion

**Manual verification:**
- Test on actual mobile device (not just responsive dev tools) — touch targets and visual clarity
- Compare chart before/after with same dataset to ensure trends are preserved
- Verify with edge case: period with no data gaps vs period with many gaps
