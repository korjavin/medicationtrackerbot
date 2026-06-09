package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/domain/workout"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// -- Workout Group Handlers --

func (s *Server) handleListWorkoutGroups(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	groups, err := s.workouts.ListGroups(userID, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(groups); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleCreateWorkoutGroup(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Name                       string `json:"name"`
		Description                string `json:"description"`
		IsRotating                 bool   `json:"is_rotating"`
		DaysOfWeek                 string `json:"days_of_week"` // JSON array as string
		ScheduledTime              string `json:"scheduled_time"`
		NotificationAdvanceMinutes int    `json:"notification_advance_minutes"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	group, err := s.workouts.CreateGroup(
		req.Name,
		req.Description,
		req.IsRotating,
		userID,
		req.DaysOfWeek,
		req.ScheduledTime,
		req.NotificationAdvanceMinutes,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Create initial snapshot
	snapshotData := fmt.Sprintf(`{"name":"%s","days_of_week":%s,"scheduled_time":"%s","notification_advance_minutes":%d}`,
		req.Name, req.DaysOfWeek, req.ScheduledTime, req.NotificationAdvanceMinutes)
	if err := s.workouts.CreateGroupSnapshot(group.ID, snapshotData, "Initial setup"); err != nil {
		slog.Error("create group snapshot", "error", err)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(group); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleUpdateWorkoutGroup(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid group ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name                       string `json:"name"`
		Description                string `json:"description"`
		IsRotating                 bool   `json:"is_rotating"`
		DaysOfWeek                 string `json:"days_of_week"`
		ScheduledTime              string `json:"scheduled_time"`
		NotificationAdvanceMinutes int    `json:"notification_advance_minutes"`
		Active                     bool   `json:"active"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.workouts.UpdateGroup(
		id,
		req.Name,
		req.Description,
		req.IsRotating,
		req.DaysOfWeek,
		req.ScheduledTime,
		req.NotificationAdvanceMinutes,
		req.Active,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Create snapshot on update
	snapshotData := fmt.Sprintf(`{"name":"%s","days_of_week":%s,"scheduled_time":"%s","notification_advance_minutes":%d}`,
		req.Name, req.DaysOfWeek, req.ScheduledTime, req.NotificationAdvanceMinutes)
	if err := s.workouts.CreateGroupSnapshot(id, snapshotData, "Settings updated"); err != nil {
		slog.Error("create group snapshot", "error", err)
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleSkipWorkoutSessionCompat(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		SessionID int64 `json:"session_id"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetSession(req.SessionID)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	if err := s.workoutSvc.SkipSession(req.SessionID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if s.workout != nil {
		s.workout.ClearPendingExercises(req.SessionID)
		if err := s.workout.CleanupWorkoutSessionMessages(req.SessionID); err != nil {
			slog.Error("Failed to cleanup workout messages for session", "sessionID", req.SessionID, "error", err)
		}
	}

	if session.NotificationMessageID != nil {
		s.deleteNotification(r.Context(), *session.NotificationMessageID)
	}
	s.closeNotification(r.Context(), fmt.Sprintf("workout-%d", req.SessionID))

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleSnoozeWorkoutSessionCompat(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		SessionID     int64 `json:"session_id"`
		DurationHours int   `json:"duration_hours"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetSession(req.SessionID)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	minutes := req.DurationHours * 60
	if minutes <= 0 {
		minutes = 60
	}

	if err := s.workoutSvc.SnoozeSession(req.SessionID, time.Duration(minutes)*time.Minute); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if session.NotificationMessageID != nil {
		s.deleteNotification(r.Context(), *session.NotificationMessageID)
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteWorkoutGroup(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid group ID", http.StatusBadRequest)
		return
	}

	err = s.workouts.DeleteGroup(id)
	if err != nil {
		// Return precondition errors as 409 Conflict so the frontend can show them
		if strings.Contains(err.Error(), "cannot delete group") {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// -- Workout Variant Handlers --

func (s *Server) handleListVariantsByGroup(w http.ResponseWriter, r *http.Request) {
	groupIDStr := r.URL.Query().Get("group_id")
	groupID, err := strconv.ParseInt(groupIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid group ID", http.StatusBadRequest)
		return
	}

	variants, err := s.workouts.ListVariantsByGroup(groupID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(variants); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleCreateWorkoutVariant(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GroupID       int64  `json:"group_id"`
		Name          string `json:"name"`
		RotationOrder *int   `json:"rotation_order"`
		Description   string `json:"description"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	variant, err := s.workouts.CreateVariant(
		req.GroupID,
		req.Name,
		req.RotationOrder,
		req.Description,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(variant); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleUpdateWorkoutVariant(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid variant ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name          string `json:"name"`
		RotationOrder *int   `json:"rotation_order"`
		Description   string `json:"description"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.workouts.UpdateVariant(id, req.Name, req.RotationOrder, req.Description)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteWorkoutVariant(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid variant ID", http.StatusBadRequest)
		return
	}

	err = s.workouts.DeleteVariant(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// -- Exercise Handlers --

func (s *Server) handleListExercisesByVariant(w http.ResponseWriter, r *http.Request) {
	variantIDStr := r.URL.Query().Get("variant_id")
	variantID, err := strconv.ParseInt(variantIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid variant ID", http.StatusBadRequest)
		return
	}

	exercises, err := s.workouts.ListExercisesByVariant(variantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(exercises); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleCreateExercise(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VariantID      int64    `json:"variant_id"`
		ExerciseName   string   `json:"exercise_name"`
		TargetSets     int      `json:"target_sets"`
		TargetRepsMin  int      `json:"target_reps_min"`
		TargetRepsMax  *int     `json:"target_reps_max"`
		TargetWeightKg *float64 `json:"target_weight_kg"`
		OrderIndex     int      `json:"order_index"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	exercise, err := s.workouts.CreateExerciseInVariant(
		req.VariantID,
		req.ExerciseName,
		req.TargetSets,
		req.TargetRepsMin,
		req.TargetRepsMax,
		req.TargetWeightKg,
		req.OrderIndex,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(exercise); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleUpdateExercise(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid exercise ID", http.StatusBadRequest)
		return
	}

	var req struct {
		ExerciseName   string   `json:"exercise_name"`
		TargetSets     int      `json:"target_sets"`
		TargetRepsMin  int      `json:"target_reps_min"`
		TargetRepsMax  *int     `json:"target_reps_max"`
		TargetWeightKg *float64 `json:"target_weight_kg"`
		OrderIndex     int      `json:"order_index"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.workouts.UpdateExercise(
		id,
		req.ExerciseName,
		req.TargetSets,
		req.TargetRepsMin,
		req.TargetRepsMax,
		req.TargetWeightKg,
		req.OrderIndex,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteExercise(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid exercise ID", http.StatusBadRequest)
		return
	}

	err = s.workouts.DeleteExercise(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// -- Session Handlers --

func (s *Server) handleListWorkoutSessions(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	limitStr := r.URL.Query().Get("limit")
	limit := 30 // default
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil {
			limit = l
		}
	}

	enriched, err := s.workoutSvc.ListSessions(userID, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(enriched); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleGetSessionDetails(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}

	details, err := s.workoutSvc.GetSessionDetails(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if details == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(details); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleGetNextWorkout(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	next, err := s.workoutSvc.GetNext(userID)
	if err != nil {
		// Preserve the legacy 500 body for a lazy-create failure; every other
		// engine error maps to a plain 500 carrying the underlying error string.
		var cse *workoutsvc.CreateSessionError
		if errors.As(err, &cse) {
			http.Error(w, fmt.Sprintf("Error creating session: %v", cse.Err), http.StatusInternalServerError)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	// A nil *NextWorkout marshals to JSON null, preserving the legacy "no workout" shape.
	if err := json.NewEncoder(w).Encode(next); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// -- Stats Handlers --

func (s *Server) handleGetWorkoutStats(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Fetch enough sessions for streak + 30-day stats
	sessions, err := s.workouts.ListHistory(userID, 500)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	since30 := time.Now().AddDate(0, 0, -30)

	// 30-day counts
	totalSessions := 0
	completedSessions := 0
	skippedSessions := 0

	// Weekly activity heatmap (last 12 weeks)
	type WeekActivity struct {
		Week      string `json:"week"`
		Completed int    `json:"completed"`
		Skipped   int    `json:"skipped"`
	}
	weekMap := make(map[string]*WeekActivity)
	cutoff12w := time.Now().AddDate(0, 0, -84)
	mondayOf := func(t time.Time) string {
		d := t
		for d.Weekday() != time.Monday {
			d = d.AddDate(0, 0, -1)
		}
		return d.Format("2006-01-02")
	}

	for _, session := range sessions {
		// 30-day stats
		if !session.ScheduledDate.Before(since30) {
			switch session.Status {
			case "completed":
				completedSessions++
				totalSessions++
			case "skipped":
				skippedSessions++
				totalSessions++
			}
		}

		// Weekly heatmap
		if !session.ScheduledDate.Before(cutoff12w) {
			week := mondayOf(session.ScheduledDate)
			if _, ok := weekMap[week]; !ok {
				weekMap[week] = &WeekActivity{Week: week}
			}
			switch session.Status {
			case "completed":
				weekMap[week].Completed++
			case "skipped":
				weekMap[week].Skipped++
			}
		}
	}

	// Sort weekly activity chronologically
	var weekKeys []string
	for w := range weekMap {
		weekKeys = append(weekKeys, w)
	}
	sort.Strings(weekKeys)
	var weeklyActivity []WeekActivity
	activeWeeks := 0
	for _, w := range weekKeys {
		activity := *weekMap[w]
		weeklyActivity = append(weeklyActivity, activity)
		if activity.Completed > 0 {
			activeWeeks++
		}
	}

	// Exercise stats from DB
	exerciseStats, _ := s.workouts.ListExerciseStats(userID)

	completionRate := 0.0
	if totalSessions > 0 {
		completionRate = float64(completedSessions) / float64(totalSessions) * 100
	}

	stats := struct {
		TotalSessions     int                  `json:"total_sessions"`
		CompletedSessions int                  `json:"completed_sessions"`
		SkippedSessions   int                  `json:"skipped_sessions"`
		CompletionRate    float64              `json:"completion_rate"`
		ActiveWeeks       int                  `json:"active_weeks"`
		TopExercises      []store.ExerciseStat `json:"top_exercises"`
		WeeklyActivity    []WeekActivity       `json:"weekly_activity"`
	}{
		TotalSessions:     totalSessions,
		CompletedSessions: completedSessions,
		SkippedSessions:   skippedSessions,
		CompletionRate:    completionRate,
		ActiveWeeks:       activeWeeks,
		TopExercises:      exerciseStats,
		WeeklyActivity:    weeklyActivity,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(stats); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// -- Rotation Handlers --

func (s *Server) handleGetRotationState(w http.ResponseWriter, r *http.Request) {
	groupIDStr := r.URL.Query().Get("group_id")
	groupID, err := strconv.ParseInt(groupIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid group ID", http.StatusBadRequest)
		return
	}

	state, err := s.workouts.GetRotationState(groupID)
	if err != nil || state == nil {
		http.Error(w, "Rotation state not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(state); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleInitializeRotation(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GroupID           int64 `json:"group_id"`
		StartingVariantID int64 `json:"starting_variant_id"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err := s.workouts.InitializeRotation(req.GroupID, req.StartingVariantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// validateExerciseValues checks that sets, reps, and weight are within
// reasonable bounds. Nil values are allowed (means "don't change").
func validateExerciseValues(sets, reps *int, weight *float64) error {
	if sets != nil && *sets < 0 {
		return fmt.Errorf("sets must be non-negative")
	}
	if reps != nil && *reps < 0 {
		return fmt.Errorf("reps must be non-negative")
	}
	if weight != nil && *weight < 0 {
		return fmt.Errorf("weight must be non-negative")
	}
	return nil
}

func (s *Server) handleUpdateExerciseLog(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID            int64    `json:"id"`
		SetsCompleted *int     `json:"sets_completed"`
		RepsCompleted *int     `json:"reps_completed"`
		WeightKg      *float64 `json:"weight_kg"`
		Notes         string   `json:"notes"`
		Status        string   `json:"status"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := validateExerciseValues(req.SetsCompleted, req.RepsCompleted, req.WeightKg); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	switch req.Status {
	case "", "completed", "skipped":
		// allowed
	default:
		http.Error(w, "status must be one of \"\", \"completed\", \"skipped\"", http.StatusBadRequest)
		return
	}

	err := s.workouts.UpdateExerciseLog(req.ID, req.SetsCompleted, req.RepsCompleted, req.WeightKg, req.Notes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Best-effort propagation of weight/reps/sets to workout schedule.
	// Only propagate non-zero values to avoid overwriting schedule with defaults.
	propagateSets := req.SetsCompleted
	propagateReps := req.RepsCompleted
	if propagateSets != nil && *propagateSets == 0 {
		propagateSets = nil
	}
	if propagateReps != nil && *propagateReps == 0 {
		propagateReps = nil
	}
	logEntry, logErr := s.workouts.GetExerciseLogByID(req.ID)
	switch {
	case logErr != nil:
		slog.Error("propagate: fetch exercise log", "error", logErr, "log_id", req.ID)
	case logEntry == nil:
		slog.Error("propagate: exercise log not found after update", "log_id", req.ID)
	case logEntry.Source == "library":
		// Skip propagation for library-sourced logs: their exercise_id is from
		// exercise_library, not workout_exercises. Without this check, ID collisions
		// between the two tables could corrupt scheduled exercise definitions.
		slog.Info("propagate: skipping library-sourced exercise log", "log_id", req.ID, "exercise_name", logEntry.ExerciseName)
	default:
		if err := s.workouts.PropagateExerciseToSchedule(
			logEntry.SessionID, logEntry.ExerciseID, logEntry.ExerciseName,
			propagateSets, propagateReps, req.WeightKg,
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
	newStatus := req.Status
	if newStatus == "" && logEntry != nil && logEntry.Status == "" &&
		req.SetsCompleted != nil && *req.SetsCompleted >= 1 {
		newStatus = "completed"
	}
	if newStatus != "" && logEntry != nil && logEntry.Status != newStatus {
		if err := s.workouts.UpdateExerciseLogStatus(req.ID, newStatus); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteWorkoutSession(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}

	err = s.workouts.DeleteSession(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteExerciseLog(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid log ID", http.StatusBadRequest)
		return
	}

	// Auth middleware already ensures only the allowed user can call this API.
	err = s.workouts.DeleteExerciseLog(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleGetUniqueExercises(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	exercises, err := s.workouts.ListAllUniqueExercises(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(exercises); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleAddExerciseToSession(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		SessionID      int64    `json:"session_id"`
		ExerciseID     int64    `json:"exercise_id"`
		ExerciseName   string   `json:"exercise_name"`
		TargetSets     int      `json:"target_sets"`
		TargetRepsMin  int      `json:"target_reps_min"`
		TargetRepsMax  *int     `json:"target_reps_max"`
		TargetWeightKg *float64 `json:"target_weight_kg"`
		Status         string   `json:"status"` // completed, skipped
		Notes          string   `json:"notes"`
		Source         string   `json:"source"` // "schedule" or "library"; defaults to "schedule"
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.SessionID == 0 || req.ExerciseID == 0 {
		http.Error(w, "SessionID and ExerciseID are required", http.StatusBadRequest)
		return
	}

	if err := validateExerciseValues(&req.TargetSets, &req.TargetRepsMin, req.TargetWeightKg); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Verify session ownership
	session, err := s.workouts.GetSession(req.SessionID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	sets := req.TargetSets
	reps := req.TargetRepsMin
	weight := req.TargetWeightKg

	// Use the correct source from the start so the insert is atomic —
	// no two-step insert-then-retag that can collide with an existing
	// scheduled log sharing the same (session_id, exercise_id).
	source := req.Source
	if source == "" {
		source = "schedule"
	}
	if source != "schedule" && source != "library" {
		http.Error(w, "source must be 'schedule' or 'library'", http.StatusBadRequest)
		return
	}

	id, err := s.workouts.LogExerciseWithSource(
		req.SessionID,
		req.ExerciseID,
		req.ExerciseName,
		&sets,
		&reps,
		weight,
		req.Status,
		req.Notes,
		source,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
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
		if err := s.workouts.PropagateExerciseToSchedule(
			req.SessionID, req.ExerciseID, req.ExerciseName,
			propagateSets, propagateReps, weight,
		); err != nil {
			slog.Error("propagate: update schedule", "error", err, "session_id", req.SessionID, "exercise_id", req.ExerciseID)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(map[string]int64{"id": id}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleSnoozeWorkoutSession(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetSession(id)
	if err != nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	var req struct {
		Minutes int `json:"minutes"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Minutes <= 0 {
		req.Minutes = 60 // Default
	}

	if err := s.workoutSvc.SnoozeSession(id, time.Duration(req.Minutes)*time.Minute); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if session.NotificationMessageID != nil {
		s.deleteNotification(r.Context(), *session.NotificationMessageID)
	}
	s.closeNotification(r.Context(), fmt.Sprintf("workout-%d", id))

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handlePreSkipWorkoutSession(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	if err := s.workouts.PreSkipSession(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleCancelPreSkipWorkoutSession(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	if err := s.workouts.CancelPreSkip(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleNextVariantWorkoutSession(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}
	if session.Status == "in_progress" || session.Status == "completed" || session.Status == "skipped" {
		http.Error(w, "Cannot change variant for an active or completed session", http.StatusBadRequest)
		return
	}

	group, err := s.workouts.GetGroup(session.GroupID)
	if err != nil || group == nil {
		http.Error(w, "Workout group not found", http.StatusNotFound)
		return
	}
	if !group.IsRotating {
		http.Error(w, "Workout group does not use rotation", http.StatusBadRequest)
		return
	}

	if err := s.workouts.AdvanceRotation(group.ID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := s.workouts.DeleteSession(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleSkipWorkoutSession(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetSession(id)
	if err != nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	// Service handles skip + rotation advancement for rotating groups
	if err := s.workoutSvc.SkipSession(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if s.workout != nil {
		s.workout.ClearPendingExercises(id)
		if err := s.workout.CleanupWorkoutSessionMessages(id); err != nil {
			slog.Error("Failed to cleanup workout messages for session", "sessionID", id, "error", err)
		}
	}

	if session.NotificationMessageID != nil {
		s.deleteNotification(r.Context(), *session.NotificationMessageID)
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleStartWorkoutSession(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	// Mark session as in_progress, set started_at, and clear any snooze
	if err := s.workoutSvc.StartSession(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Update Telegram notification
	if s.workout != nil {
		go func() {
			session, err := s.workouts.GetSession(id)
			if err != nil || session == nil {
				return
			}

			group, _ := s.workouts.GetGroup(session.GroupID)
			variant, _ := s.workouts.GetVariant(session.VariantID)

			text := "✅ **Workout started**"
			if group != nil && variant != nil {
				text += fmt.Sprintf("\n%s - %s", group.Name, variant.Name)
			}
			text += "\n\nLet's go! 💪"

			if session.NotificationMessageID != nil {
				if err := s.workout.UpdateWorkoutMessage(*session.NotificationMessageID, text); err != nil {
					slog.Error("Failed to update workout message", "error", err)
				}
				// Keep UX consistent with Telegram-start flow: remove original notification card.
				s.deleteNotification(context.Background(), *session.NotificationMessageID)
			}
			if err := s.workout.CleanupWorkoutSessionMessages(id); err != nil {
				slog.Error("Failed to cleanup stale workout messages for session", "sessionID", id, "error", err)
			}

			if err := s.workout.StartWorkoutFlowFromWeb(id); err != nil {
				slog.Error("Failed to start workout Telegram flow from web", "error", err)
			}
		}()
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleUpdateSessionStatus(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Status string `json:"status"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Validate status - only allow final states
	validStatuses := map[string]bool{
		"in_progress": true,
		"completed":   true,
		"skipped":     true,
	}
	if !validStatuses[req.Status] {
		http.Error(w, "Invalid status. Allowed values: in_progress, completed, skipped", http.StatusBadRequest)
		return
	}

	// Get session to check for notification message
	session, err := s.workouts.GetSession(id)
	if err != nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	// Route to the appropriate service method for compound operations
	switch req.Status {
	case "skipped":
		// Service handles skip + rotation advancement for rotating groups
		if err := s.workoutSvc.SkipSession(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "completed":
		// Service handles complete + rotation advancement for rotating groups
		if err := s.workoutSvc.CompleteSession(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		// in_progress: simple status update, no compound logic
		if err := s.workouts.UpdateSessionStatus(id, req.Status); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	// If skipped or completed, clean up bot state and try to delete the notification message
	if req.Status == "skipped" || req.Status == "completed" {
		if s.workout != nil {
			s.workout.ClearPendingExercises(id)
			if err := s.workout.CleanupWorkoutSessionMessages(id); err != nil {
				slog.Error("Failed to cleanup workout messages for session", "sessionID", id, "error", err)
			}
		}
		if session.NotificationMessageID != nil {
			s.deleteNotification(r.Context(), *session.NotificationMessageID)
		}
		s.closeNotification(r.Context(), fmt.Sprintf("workout-%d", id))
	}

	w.WriteHeader(http.StatusOK)
}

// -- Exercise Library Handlers --

func (s *Server) handleListExerciseLibrary(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	items, err := s.workouts.ListExerciseLibrary(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(items); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleCreateExerciseLibraryItem(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Name            string   `json:"name"`
		DefaultSets     int      `json:"default_sets"`
		DefaultRepsMin  int      `json:"default_reps_min"`
		DefaultRepsMax  *int     `json:"default_reps_max"`
		DefaultWeightKg *float64 `json:"default_weight_kg"`
		Notes           string   `json:"notes"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Name == "" {
		http.Error(w, "Name is required", http.StatusBadRequest)
		return
	}

	item, err := s.workouts.CreateExerciseLibraryItem(userID, req.Name, req.DefaultSets, req.DefaultRepsMin, req.DefaultRepsMax, req.DefaultWeightKg, req.Notes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(item); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleUpdateExerciseLibraryItem(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name            string   `json:"name"`
		DefaultSets     int      `json:"default_sets"`
		DefaultRepsMin  int      `json:"default_reps_min"`
		DefaultRepsMax  *int     `json:"default_reps_max"`
		DefaultWeightKg *float64 `json:"default_weight_kg"`
		Notes           string   `json:"notes"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Name == "" {
		http.Error(w, "Name is required", http.StatusBadRequest)
		return
	}

	if err := s.workouts.UpdateExerciseLibraryItem(id, req.Name, req.DefaultSets, req.DefaultRepsMin, req.DefaultRepsMax, req.DefaultWeightKg, req.Notes); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteExerciseLibraryItem(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.workouts.DeleteExerciseLibraryItem(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}
