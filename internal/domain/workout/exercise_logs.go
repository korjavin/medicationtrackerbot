package workout

import (
	"errors"
	"log/slog"
)

// Sentinel errors returned by the exercise-log write methods so the transport
// layer can map each to the exact HTTP status it returned before extraction.
// validateExerciseValues used to live in the handler and returned plain
// fmt.Errorf values whose text was echoed as the 400 body; these sentinels
// reproduce that text byte-for-byte while letting the handler map them to 400.
var (
	// ErrNegativeSets is returned when sets_completed/target_sets is negative.
	ErrNegativeSets = errors.New("sets must be non-negative")
	// ErrNegativeReps is returned when reps_completed/target_reps_min is negative.
	ErrNegativeReps = errors.New("reps must be non-negative")
	// ErrNegativeWeight is returned when weight_kg/target_weight_kg is negative.
	ErrNegativeWeight = errors.New("weight must be non-negative")
	// ErrInvalidExerciseLogStatus is returned by UpdateExerciseLog for a status
	// outside {"", "completed", "skipped"}. Handlers map it to 400.
	ErrInvalidExerciseLogStatus = errors.New(`status must be one of "", "completed", "skipped"`)
)

// ValidateExerciseValues checks that sets, reps, and weight are within
// reasonable bounds. Nil values are allowed (means "don't change"). It returns
// one of the negative-value sentinels above so callers map it to 400.
func ValidateExerciseValues(sets, reps *int, weight *float64) error {
	if sets != nil && *sets < 0 {
		return ErrNegativeSets
	}
	if reps != nil && *reps < 0 {
		return ErrNegativeReps
	}
	if weight != nil && *weight < 0 {
		return ErrNegativeWeight
	}
	return nil
}

// UpdateExerciseLog validates and applies an exercise-log edit, then runs the
// two best-effort follow-ups the handler used to own: propagating non-zero
// weight/reps/sets back to the workout schedule and auto-promoting a
// placeholder log to "completed". Validation failures return a sentinel the
// handler maps to 400; the store write and the status-promotion write surface
// their errors for a 500.
func (s *Service) UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes, status string) error {
	if err := ValidateExerciseValues(setsCompleted, repsCompleted, weightKg); err != nil {
		return err
	}

	switch status {
	case "", "completed", "skipped":
		// allowed
	default:
		return ErrInvalidExerciseLogStatus
	}

	if err := s.store.UpdateExerciseLog(id, setsCompleted, repsCompleted, weightKg, notes); err != nil {
		return err
	}

	// Best-effort propagation of weight/reps/sets to workout schedule.
	// Only propagate non-zero values to avoid overwriting schedule with defaults.
	propagateSets := setsCompleted
	propagateReps := repsCompleted
	if propagateSets != nil && *propagateSets == 0 {
		propagateSets = nil
	}
	if propagateReps != nil && *propagateReps == 0 {
		propagateReps = nil
	}
	logEntry, logErr := s.store.GetExerciseLogByID(id)
	switch {
	case logErr != nil:
		slog.Error("propagate: fetch exercise log", "error", logErr, "log_id", id)
	case logEntry == nil:
		slog.Error("propagate: exercise log not found after update", "log_id", id)
	case logEntry.Source == "library":
		// Skip propagation for library-sourced logs: their exercise_id is from
		// exercise_library, not workout_exercises. Without this check, ID collisions
		// between the two tables could corrupt scheduled exercise definitions.
		slog.Info("propagate: skipping library-sourced exercise log", "log_id", id, "exercise_name", logEntry.ExerciseName)
	default:
		if err := s.store.PropagateExerciseToSchedule(
			logEntry.SessionID, logEntry.ExerciseID, logEntry.ExerciseName,
			propagateSets, propagateReps, weightKg,
		); err != nil {
			slog.Error("propagate: update schedule", "error", err, "session_id", logEntry.SessionID, "exercise_id", logEntry.ExerciseID)
		}
	}

	// Promote status when needed: explicit caller-supplied status wins; otherwise
	// auto-promote a placeholder log (status=="") to "completed" once the caller
	// records sets_completed >= 1, since the scheduled-ad-hoc design relies on
	// this endpoint to flip placeholders into the completed state that
	// stats/history queries filter on. Skip the update entirely when we
	// could not load the row — promoting status without a confirmed pre-state
	// risks overwriting an unrelated row if the id was wrong or already gone.
	newStatus := status
	if newStatus == "" && logEntry != nil && logEntry.Status == "" &&
		setsCompleted != nil && *setsCompleted >= 1 {
		newStatus = "completed"
	}
	if newStatus != "" && logEntry != nil && logEntry.Status != newStatus {
		if err := s.store.UpdateExerciseLogStatus(id, newStatus); err != nil {
			return err
		}
	}

	return nil
}

// AddExerciseToSession logs a new exercise against a session with an explicit
// source ("schedule" or "library"; the handler defaults/validates it before
// calling), then — for non-library sources — best-effort propagates the
// non-zero targets back to the workout schedule. Session ownership is verified
// by the transport layer before this is called. Returns the new log id.
func (s *Service) AddExerciseToSession(sessionID, exerciseID int64, exerciseName string, targetSets, targetRepsMin int, targetWeightKg *float64, status, notes, source string) (int64, error) {
	sets := targetSets
	reps := targetRepsMin
	weight := targetWeightKg

	// Use the correct source from the start so the insert is atomic —
	// no two-step insert-then-retag that can collide with an existing
	// scheduled log sharing the same (session_id, exercise_id).
	id, err := s.store.LogExerciseWithSource(
		sessionID,
		exerciseID,
		exerciseName,
		&sets,
		&reps,
		weight,
		status,
		notes,
		source,
	)
	if err != nil {
		return 0, err
	}

	if source != "library" {
		// Best-effort propagation for scheduled exercises.
		propagateSets := &sets
		propagateReps := &reps
		if sets == 0 {
			propagateSets = nil
		}
		if reps == 0 {
			propagateReps = nil
		}
		if err := s.store.PropagateExerciseToSchedule(
			sessionID, exerciseID, exerciseName,
			propagateSets, propagateReps, weight,
		); err != nil {
			slog.Error("propagate: update schedule", "error", err, "session_id", sessionID, "exercise_id", exerciseID)
		}
	}

	return id, nil
}
