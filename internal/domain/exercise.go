package domain

import (
	"errors"
	"fmt"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// ExerciseStore is the narrow store interface required by ExerciseService.
type ExerciseStore interface {
	GetSession(id int64) (*store.WorkoutSession, error)
	GetExercise(id int64) (*store.WorkoutExercise, error)
	GetExerciseLibraryItem(id int64) (*store.ExerciseLibraryItem, error)
	GetExerciseLogBySessionAndExercise(sessionID, exerciseID int64) (*store.WorkoutExerciseLog, error)
	GetExerciseLogBySessionExerciseSource(sessionID, exerciseID int64, source string) (*store.WorkoutExerciseLog, error)
	LogExercise(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes string) (int64, error)
	LogExerciseWithSource(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string) (int64, error)
	UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes string) error
	UpdateExerciseLogStatus(id int64, status string) error
	ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error)
	ListExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error)
}

// ExerciseService handles exercise logging business logic.
// It is responsible for idempotent upserts and session completion checks.
// The bot layer handles Telegram message sending; this service only mutates data.
type ExerciseService interface {
	// LogExercise idempotently logs an exercise for a session.
	// Returns true if the exercise state was actually changed (new log created
	// or status upgraded). Returns false on no-op (duplicate callback, already
	// completed, same status).
	// When fromLibrary is true, exerciseID refers to exercise_library.id and the
	// workout_exercises lookup is skipped, preventing cross-table ID collisions.
	// Status upgrade rules:
	//   - no existing log → create with target defaults
	//   - existing skipped → completed: upgrade values and status
	//   - existing completed → any: no-op (don't overwrite manual web edits)
	//   - existing skipped → skipped: no-op
	LogExercise(sessionID, exerciseID int64, status string, fromLibrary bool) (changed bool, err error)

	// CheckSessionCompletion determines whether all planned exercises for a
	// variant have been handled (completed or skipped).
	CheckSessionCompletion(sessionID, variantID int64) (done bool, completedCount, totalCount int, err error)
}

type exerciseService struct {
	store ExerciseStore
}

// NewExerciseService creates a new ExerciseService backed by the given store.
func NewExerciseService(s ExerciseStore) ExerciseService {
	return &exerciseService{store: s}
}

// applyUpgradeRules applies status upgrade rules for an existing exercise log.
// Returns true if the upgrade was applied, false if no changes were needed.
// The exercise parameter provides target values for upgrades from skipped to completed.
func (s *exerciseService) applyUpgradeRules(existing *store.WorkoutExerciseLog, exercise *store.WorkoutExercise, status string) (bool, error) {
	if existing.Status == "completed" {
		// No-op: don't overwrite manual edits from web app.
		return false, nil
	}
	if existing.Status == status {
		// No-op: same status.
		return false, nil
	}
	// skipped → completed: update values and status.
	if status == "completed" {
		if err := s.store.UpdateExerciseLog(existing.ID, &exercise.TargetSets, &exercise.TargetRepsMin, exercise.TargetWeightKg, ""); err != nil {
			return false, fmt.Errorf("update exercise log %d: %w", existing.ID, err)
		}
		if err := s.store.UpdateExerciseLogStatus(existing.ID, "completed"); err != nil {
			return false, fmt.Errorf("update exercise log status %d: %w", existing.ID, err)
		}
		return true, nil
	}
	return false, nil
}

func (s *exerciseService) LogExercise(sessionID, exerciseID int64, status string, fromLibrary bool) (bool, error) {
	// Guard: only allow logging to in-progress sessions. This closes the TOCTOU
	// gap between the bot's pre-check and the actual data write — if the web API
	// completed/skipped the session in the meantime, we bail out.
	session, err := s.store.GetSession(sessionID)
	if err != nil {
		return false, fmt.Errorf("get workout session %d: %w", sessionID, err)
	}
	if session == nil || session.Status != "in_progress" {
		return false, nil
	}

	var exercise *store.WorkoutExercise
	if !fromLibrary {
		exercise, err = s.store.GetExercise(exerciseID)
		if err != nil {
			return false, fmt.Errorf("get exercise %d: %w", exerciseID, err)
		}
		// Guard against ID collisions: if the exercise exists but belongs to a
		// different variant, it's a false match — fall through to library lookup.
		if exercise != nil && exercise.VariantID != session.VariantID {
			exercise = nil
			fromLibrary = true
		}
	}
	if fromLibrary || exercise == nil {
		// Look up in exercise_library: either the caller explicitly indicated a
		// library exercise, or the ID wasn't found in workout_exercises.
		libItem, libErr := s.store.GetExerciseLibraryItem(exerciseID)
		if libErr != nil {
			return false, fmt.Errorf("get exercise library item %d: %w", exerciseID, libErr)
		}
		if libItem == nil {
			return false, fmt.Errorf("exercise %d not found", exerciseID)
		}
		exercise = &store.WorkoutExercise{
			ID:             libItem.ID,
			ExerciseName:   libItem.Name,
			TargetSets:     libItem.DefaultSets,
			TargetRepsMin:  libItem.DefaultRepsMin,
			TargetRepsMax:  libItem.DefaultRepsMax,
			TargetWeightKg: libItem.DefaultWeightKg,
		}
		fromLibrary = true
	}

	// Use source-aware lookup to avoid matching a log from the other table
	// when exercise_library.id collides with workout_exercises.id.
	source := "schedule"
	if fromLibrary {
		source = "library"
	}
	existing, err := s.store.GetExerciseLogBySessionExerciseSource(sessionID, exerciseID, source)
	if err != nil {
		return false, fmt.Errorf("get existing log for session %d exercise %d: %w", sessionID, exerciseID, err)
	}

	if existing != nil {
		// Already logged — apply upgrade rules.
		applied, err := s.applyUpgradeRules(existing, exercise, status)
		if err != nil {
			return false, err
		}
		return applied, nil
	}

	// No existing log — create new.
	var sets *int
	var reps *int
	var weight *float64
	if status == "completed" {
		sets = &exercise.TargetSets
		reps = &exercise.TargetRepsMin
		weight = exercise.TargetWeightKg
	}
	if _, err := s.store.LogExerciseWithSource(sessionID, exerciseID, exercise.ExerciseName, sets, reps, weight, status, "", source); err != nil {
		// Handle race condition: another concurrent insert may have beaten us.
		// If it's a unique constraint error, re-check if row now exists.
		var sqlErr *sqlite.Error
		if errors.As(err, &sqlErr) && (sqlErr.Code() == sqlite3.SQLITE_CONSTRAINT || sqlErr.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE) {
			existing, err := s.store.GetExerciseLogBySessionExerciseSource(sessionID, exerciseID, source)
			if err != nil {
				return false, fmt.Errorf("get existing log after race for session %d exercise %d: %w", sessionID, exerciseID, err)
			}
			if existing != nil {
				// Row now exists - apply upgrade rules.
				applied, err := s.applyUpgradeRules(existing, exercise, status)
				if err != nil {
					return false, err
				}
				return applied, nil
			}
		}
		return false, fmt.Errorf("log exercise %d for session %d: %w", exerciseID, sessionID, err)
	}
	return true, nil
}

func (s *exerciseService) CheckSessionCompletion(sessionID, variantID int64) (bool, int, int, error) {
	exercises, err := s.store.ListExercisesByVariant(variantID)
	if err != nil {
		return false, 0, 0, fmt.Errorf("list exercises for variant %d: %w", variantID, err)
	}

	logs, err := s.store.ListExerciseLogs(sessionID)
	if err != nil {
		return false, 0, 0, fmt.Errorf("get exercise logs for session %d: %w", sessionID, err)
	}

	plannedIDs := make([]int64, len(exercises))
	for i, ex := range exercises {
		plannedIDs[i] = ex.ID
	}

	logStatuses := make([]ExerciseLogStatus, len(logs))
	for i, l := range logs {
		logStatuses[i] = ExerciseLogStatus{ExerciseID: l.ExerciseID, Status: l.Status, Source: l.Source}
	}

	result := CheckCompletion(plannedIDs, logStatuses)
	return result.AllDone, result.CompletedCount, result.TotalCount, nil
}
