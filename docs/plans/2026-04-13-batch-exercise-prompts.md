# Batch Exercise Prompts in Telegram (max 3 open at a time)

## Overview

When a workout starts, instead of posting all exercise prompts at once (which clutters the chat), send only the first 3. As the user completes or skips exercises, post more to maintain at most 3 unfinished exercise prompts in the Telegram dialogue.

## Context

- Files involved: `internal/bot/workout_callbacks.go` (startExerciseLoop, handleExerciseCallback, checkWorkoutCompletion), `internal/bot/workout.go` (SendExercisePrompt)
- Related patterns: exercise callbacks already call checkWorkoutCompletion after each done/skip action
- The bot tracks workout messages via in-memory map (trackWorkoutMessage)

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Refactor startExerciseLoop to send only first 3 exercises and track remaining

**Files:**
- Modify: `internal/bot/workout_callbacks.go`

The current `startExerciseLoop` iterates all exercises and sends a prompt for each. Change it to:

1. Send prompts for only the first 3 (or fewer if total < 3)
2. Store the remaining unsent exercises in a new in-memory map on the Bot struct (similar to `workoutMessages`): `pendingExercises map[int64][]pendingExercise` keyed by sessionID, where `pendingExercise` holds the exercise metadata needed to call `SendExercisePrompt`
3. Update the "X exercises to complete" start message to say e.g. "6 exercises to complete (showing first 3)"

- [x] Add `pendingExercise` struct and `pendingExercises` map (with mutex) to Bot struct in `bot.go`
- [x] Refactor `startExerciseLoop` to send min(3, len(exercises)) prompts and store the rest
- [x] Update the start message text to reflect batching when there are more than 3 exercises

### Task 2: Send next exercises after done/skip callbacks

**Files:**
- Modify: `internal/bot/workout_callbacks.go`

After each exercise done/skip/edit callback (in `handleExerciseCallback`), check how many unfinished exercise prompts remain in chat. If fewer than 3 and there are pending exercises, send the next one(s) to top back up to 3.

The count of "open" prompts = (already sent count) - (done + skipped count from exercise logs). Simpler approach: after handling a callback, pop from the pending queue and send one prompt (since one was just resolved, sending one maintains the count).

- [x] Add a `sendNextPendingExercises` method that pops one exercise from `pendingExercises[sessionID]` and sends its prompt
- [x] Call `sendNextPendingExercises` in handleExerciseCallback after each done/skip/edit action, before `checkWorkoutCompletion`
- [x] Clean up `pendingExercises[sessionID]` entry when queue is empty or session finishes (in skip/finish handlers in handleWorkoutCallback)

### Task 3: Add tests

**Files:**
- Create: `internal/bot/workout_batch_test.go`

Test the batching logic:

- [ ] Test that startExerciseLoop with 5 exercises only sends 3 prompts and stores 2 pending
- [ ] Test that startExerciseLoop with 2 exercises sends all 2 and stores 0 pending
- [ ] Test that after a done/skip callback, one pending exercise is sent
- [ ] Test that when pending queue is empty, no extra messages are sent
- [ ] Run `go test ./...` - must pass

### Task 4: Verify acceptance criteria

- [ ] Run full test suite (`go test ./...`)
- [ ] Verify: workout with <= 3 exercises behaves exactly as before (all sent at once)
- [ ] Verify: workout with > 3 exercises sends only first 3, then one more per done/skip

### Task 5: Update documentation

- [ ] Update CLAUDE.md if internal patterns changed (add note about exercise batching)
- [ ] Move this plan to `docs/plans/completed/`
