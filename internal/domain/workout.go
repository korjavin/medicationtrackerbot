package domain

// SessionStatus is a minimal representation of a workout session for streak calculation.
type SessionStatus struct {
	Status string // "completed", "skipped", "pending", etc.
}

// CalculateStreak counts consecutive completed sessions from the beginning of the slice.
// Sessions are expected to be ordered most-recent first.
func CalculateStreak(sessions []SessionStatus) int {
	streak := 0
	for _, session := range sessions {
		if session.Status == "completed" {
			streak++
		} else if session.Status == "skipped" || session.Status == "pending" {
			break
		}
	}
	return streak
}

// ExerciseLogStatus is a minimal representation of an exercise log entry.
type ExerciseLogStatus struct {
	ExerciseID int64
	Status     string // "completed", "skipped"
	Source     string // "schedule" or "library"
}

// CompletionResult holds the result of checking workout completion.
type CompletionResult struct {
	CompletedCount int
	TotalCount     int
	AllDone        bool
}

// CheckCompletion determines if all planned exercises are handled (completed or skipped).
// plannedExerciseIDs is the list of exercise IDs planned for the workout.
// logs contains the exercise log entries with their status and source.
// Only schedule-sourced logs can satisfy planned exercises — library-sourced logs
// with a colliding numeric ID must not falsely mark a planned exercise as handled.
func CheckCompletion(plannedExerciseIDs []int64, logs []ExerciseLogStatus) CompletionResult {
	// Only schedule-sourced logs can mark planned exercises as handled.
	handledExerciseIDs := make(map[int64]bool)

	// Use (ExerciseID, Source) as composite key to avoid merging logs from
	// different tables that happen to share a numeric ID.
	type logKey struct {
		ExerciseID int64
		Source     string
	}
	uniqueCompleted := make(map[logKey]bool)
	allRelated := make(map[logKey]bool)

	for _, id := range plannedExerciseIDs {
		allRelated[logKey{id, "schedule"}] = true
	}

	for _, log := range logs {
		src := log.Source
		if src == "" {
			src = "schedule" // backward compat for logs without source
		}
		key := logKey{log.ExerciseID, src}
		allRelated[key] = true
		if log.Status == "completed" || log.Status == "skipped" {
			if src == "schedule" || src == "" {
				handledExerciseIDs[log.ExerciseID] = true
			}
		}
		if log.Status == "completed" {
			uniqueCompleted[key] = true
		}
	}

	allPlannedCompleted := true
	for _, id := range plannedExerciseIDs {
		if !handledExerciseIDs[id] {
			allPlannedCompleted = false
			break
		}
	}

	return CompletionResult{
		CompletedCount: len(uniqueCompleted),
		TotalCount:     len(allRelated),
		AllDone:        allPlannedCompleted,
	}
}
