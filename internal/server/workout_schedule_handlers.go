package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

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

	exercises := make([]workoutsvc.PlannedExercise, 0, len(req.Exercises))
	// Track non-zero exercise_ids so we reject duplicates upfront with a clear
	// 400 — otherwise the unique index on workout_exercise_logs(session_id,
	// exercise_id, source) WHERE exercise_id > 0 would surface as a 500 after
	// the session row was already created.
	seenExerciseIDs := make(map[int64]bool)
	for _, ex := range req.Exercises {
		if ex.ExerciseName == "" {
			http.Error(w, "exercises[].exercise_name is required", http.StatusBadRequest)
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
		if ex.ExerciseID > 0 {
			if seenExerciseIDs[ex.ExerciseID] {
				http.Error(w, "exercises[].exercise_id values must be unique within a request", http.StatusBadRequest)
				return
			}
			seenExerciseIDs[ex.ExerciseID] = true
		}
		exercises = append(exercises, workoutsvc.PlannedExercise{
			ExerciseID:     ex.ExerciseID,
			ExerciseName:   ex.ExerciseName,
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
