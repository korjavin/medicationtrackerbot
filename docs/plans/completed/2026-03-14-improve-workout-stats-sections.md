---
# Improve Workout Stats Sections

## Overview
Replace the confusing streak metrics with more meaningful "Active Weeks" counter, fix the incomplete heatmap legend, and replace total volume lifted with a simpler "30-Day Sessions" count. The changes address three issues: streaks don't make sense when skipping workouts is common, the heatmap legend is missing the yellow color for partial completions, and total volume is not a useful metric for the user.

## Context
Files involved:
  - `internal/server/workout_handlers.go` - Stats API endpoint (handleGetWorkoutStats)
  - `web/static/js/workout.js` - Frontend stats rendering (_renderWorkoutStats)

Related patterns:
  - The stats API returns a JSON response with current_streak, longest_streak, total_volume_kg, and weekly_activity
  - Frontend uses hero cards (gradient background) for top metrics and simple cards for secondary metrics

Dependencies: None (uses existing workout session and exercise log data)

## Development Approach
  - Regular testing approach (code first, then tests)
  - Complete each task fully before moving to the next
  - All changes are to existing stats calculation and rendering - no new database tables or migrations needed
  - CRITICAL: every task MUST include new/updated tests
  - CRITICAL: all tests must pass before starting next task

## Implementation Steps

### Task 1: Update stats API to calculate Active Weeks and remove streak metrics

**Files:**
  - Modify: `internal/server/workout_handlers.go`

  - [ ] Remove current_streak and longest_streak calculation code (lines ~954-974)
  - [ ] Add activeWeeks calculation: count weeks (from weekly_activity) with at least 1 completed session
  - [ ] Update the stats response struct: replace CurrentStreak and LongestStreak with ActiveWeeks
  - [ ] Keep 30-Day Completion Rate as-is (already calculated)
  - [ ] Add ActiveWeeks int field to the stats response struct (around line 1038)
  - [ ] Remove total_volume_kg calculation from the response struct (will be recalculated per-exercise in frontend only)

### Task 2: Update frontend stats rendering to use new metrics

**Files:**
  - Modify: `web/static/js/workout.js`

  - [ ] Replace the "Streak" hero card (line ~2034) with "Active Weeks" using stats.active_weeks
  - [ ] Replace the "Best" hero card (line ~2035) with "30-Day Sessions" using stats.completed_sessions
  - [ ] Remove or replace the "30-Day" hero card (line ~2036) - or keep it as completion rate and rename clearly
  - [ ] Update the totals grid (lines ~2069-2071): keep "Done" and "Skipped", remove "Lifted"
  - [ ] Ensure the Top Exercises section still shows per-exercise volume (lines ~2074-2137)

### Task 3: Fix the heatmap legend to include all colors

**Files:**
  - Modify: `web/static/js/workout.js`

  - [ ] Add the missing yellow (#ffc107) legend item for <50% completions (after line ~2204)
  - [ ] Update the legend order: All done (#28a745), Partial >=50% (#85c17e), Partial <50% (#ffc107), Skipped (#e05c5c)
  - [ ] Ensure the heatmap squares (lines ~2158-2178) use colors that match the updated legend

### Task 4: Write tests for updated stats calculation

**Files:**
  - Modify: `internal/server/workout_handlers_test.go` (or create if it doesn't exist)

  - [ ] Test that active_weeks correctly counts weeks with completed sessions
  - [ ] Test that streak-related fields (current_streak, longest_streak) are no longer in the API response
  - [ ] Test that the response includes active_weeks field
  - [ ] Test that weekly_activity is still correctly calculated
  - [ ] Test that completion_rate is still correctly calculated

### Task 5: Update frontend tests for stats rendering

**Files:**
  - Modify: `web/static/js/tests/workout.session-and-stats.test.js`

  - [ ] Update test expectations to use active_weeks instead of streaks
  - [ ] Verify the hero cards render the correct metrics
  - [ ] Verify the legend includes all four colors including yellow

### Task 6: Verify acceptance criteria

  - [ ] manual test: Open the workout stats tab and verify:
  - Hero cards show "Active Weeks" and "30-Day Sessions" (no streaks)
  - Heatmap legend shows 4 colors: green, light green, yellow, red
  - Totals section shows "Done" and "Skipped" (no "Lifted")
  - Top Exercises still shows volume per exercise
  - [ ] run full test suite (go test ./...)
  - [ ] verify test coverage meets 80%+ for modified files

### Task 7: Update documentation

  - [ ] Update CLAUDE.md if the stats API response format changed (document new active_weeks field, removed streaks)
  - [ ] Move this plan to `docs/plans/completed/`
