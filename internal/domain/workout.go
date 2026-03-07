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
}

// CompletionResult holds the result of checking workout completion.
type CompletionResult struct {
	CompletedCount int
	TotalCount     int
	AllDone        bool
}

// CheckCompletion determines if all planned exercises are handled (completed or skipped).
// plannedExerciseIDs is the list of exercise IDs planned for the workout.
// logs contains the exercise log entries with their status.
func CheckCompletion(plannedExerciseIDs []int64, logs []ExerciseLogStatus) CompletionResult {
	handledExerciseIDs := make(map[int64]bool)
	uniqueCompletedIDs := make(map[int64]bool)
	allRelatedExerciseIDs := make(map[int64]bool)

	for _, id := range plannedExerciseIDs {
		allRelatedExerciseIDs[id] = true
	}

	for _, log := range logs {
		allRelatedExerciseIDs[log.ExerciseID] = true
		if log.Status == "completed" || log.Status == "skipped" {
			handledExerciseIDs[log.ExerciseID] = true
		}
		if log.Status == "completed" {
			uniqueCompletedIDs[log.ExerciseID] = true
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
		CompletedCount: len(uniqueCompletedIDs),
		TotalCount:     len(allRelatedExerciseIDs),
		AllDone:        allPlannedCompleted,
	}
}
