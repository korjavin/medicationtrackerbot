package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

// maxScheduledExercises caps a single schedule request. The body is already
// MaxBytesReader-bounded, but ~30-byte JSON entries leave room for thousands
// of exercises in 1 MiB; bound the count explicitly so the per-exercise
// LogExerciseWithSource loop (and the rollback DeleteSession on failure
// inside it) can't run away.
const maxScheduledExercises = 50

type scheduleAdHocExerciseRequest struct {
	ExerciseID     int64    `json:"exercise_id"`
	ExerciseName   string   `json:"exercise_name"`
	TargetSets     int      `json:"target_sets"`
	TargetRepsMin  int      `json:"target_reps_min"`
	TargetRepsMax  *int     `json:"target_reps_max"`
	TargetWeightKg *float64 `json:"target_weight_kg"`
}

type scheduleAdHocRequest struct {
	ScheduledDate string                         `json:"scheduled_date"`
	ScheduledTime string                         `json:"scheduled_time"`
	Exercises     []scheduleAdHocExerciseRequest `json:"exercises"`
}

// handleScheduleAdHocWorkoutSession schedules a future ad-hoc workout session
// with a pre-selected list of planned exercises. The created session is in
// 'pending' state until the user starts it (or the scheduler notifies them).
func (s *Server) handleScheduleAdHocWorkoutSession(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req scheduleAdHocRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	scheduledDate, err := time.Parse("2006-01-02", req.ScheduledDate)
	if err != nil {
		http.Error(w, "scheduled_date must be YYYY-MM-DD", http.StatusBadRequest)
		return
	}

	if len(req.Exercises) == 0 {
		http.Error(w, "exercises must not be empty", http.StatusBadRequest)
		return
	}
	if len(req.Exercises) > maxScheduledExercises {
		http.Error(w, "too many exercises in a single request", http.StatusBadRequest)
		return
	}

	exercises := make([]workoutsvc.PlannedExercise, 0, len(req.Exercises))
	// Track duplicates upfront with a clear 400. The unique index on
	// workout_exercise_logs is `(session_id, exercise_id, source) WHERE
	// exercise_id > 0`, so it does NOT catch:
	//   - two free-form entries (exercise_id=0) with the same name
	//   - one library-id entry plus one free-form entry that resolves to the
	//     same name
	// Without this de-dupe the user would silently get duplicate placeholders
	// in the same session.
	seenExerciseIDs := make(map[int64]bool)
	seenNames := make(map[string]bool)
	for _, ex := range req.Exercises {
		if ex.ExerciseID < 0 {
			http.Error(w, "exercises[].exercise_id must be >= 0", http.StatusBadRequest)
			return
		}
		if ex.ExerciseName == "" && ex.ExerciseID == 0 {
			http.Error(w, "exercises[] requires exercise_id or exercise_name", http.StatusBadRequest)
			return
		}
		if ex.TargetSets < 1 || ex.TargetRepsMin < 1 {
			http.Error(w, "exercises[].target_sets and target_reps_min must be >= 1", http.StatusBadRequest)
			return
		}
		if ex.TargetRepsMax != nil && *ex.TargetRepsMax < ex.TargetRepsMin {
			http.Error(w, "exercises[].target_reps_max must be >= target_reps_min", http.StatusBadRequest)
			return
		}
		name := ex.ExerciseName
		if ex.ExerciseID > 0 {
			if seenExerciseIDs[ex.ExerciseID] {
				http.Error(w, "exercises[].exercise_id values must be unique within a request", http.StatusBadRequest)
				return
			}
			seenExerciseIDs[ex.ExerciseID] = true

			item, lookupErr := s.workouts.GetExerciseLibraryItem(ex.ExerciseID)
			if lookupErr != nil {
				slog.Error("schedule ad-hoc workout session: lookup library item", "error", lookupErr, "exercise_id", ex.ExerciseID)
				http.Error(w, "failed to resolve exercise_id", http.StatusInternalServerError)
				return
			}
			if item == nil || item.UserID != userID {
				http.Error(w, "exercises[].exercise_id not found in this user's library", http.StatusBadRequest)
				return
			}
			if name == "" {
				name = item.Name
			}
		}
		nameKey := strings.ToLower(strings.TrimSpace(name))
		if nameKey != "" {
			if seenNames[nameKey] {
				http.Error(w, "exercises[] names must be unique within a request", http.StatusBadRequest)
				return
			}
			seenNames[nameKey] = true
		}
		exercises = append(exercises, workoutsvc.PlannedExercise{
			ExerciseID:     ex.ExerciseID,
			ExerciseName:   name,
			TargetSets:     ex.TargetSets,
			TargetRepsMin:  ex.TargetRepsMin,
			TargetRepsMax:  ex.TargetRepsMax,
			TargetWeightKg: ex.TargetWeightKg,
		})
	}

	session, err := s.workoutSvc.SchedulePlannedAdHocSession(userID, scheduledDate, req.ScheduledTime, exercises)
	if err != nil {
		switch {
		case errors.Is(err, workoutsvc.ErrScheduleInPast), errors.Is(err, workoutsvc.ErrScheduleBadTime):
			http.Error(w, err.Error(), http.StatusBadRequest)
		default:
			slog.Error("schedule ad-hoc workout session", "error", err)
			http.Error(w, "failed to schedule workout session", http.StatusInternalServerError)
		}
		return
	}

	resp := struct {
		Session *store.WorkoutSession `json:"session"`
		Planned int                   `json:"planned"`
	}{
		Session: session,
		Planned: len(exercises),
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.Error("encode response", "error", err)
	}
}
