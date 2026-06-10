package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/domain/workout"
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

	// GetSession is the ownership/existence guard for this auth-scoped route and
	// supplies NotificationMessageID for the transport-layer notification cleanup
	// below; the skip + rotation advancement routes through the service.
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

	// GetSession is the ownership/existence guard for this auth-scoped route and
	// supplies NotificationMessageID for the transport-layer notification cleanup
	// below; the snooze state transition routes through the service.
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

	stats, err := s.workoutSvc.GetStats(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
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

	state, err := s.workoutSvc.GetRotationState(groupID)
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

	err := s.workoutSvc.InitializeRotation(req.GroupID, req.StartingVariantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
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

	err := s.workoutSvc.UpdateExerciseLog(req.ID, req.SetsCompleted, req.RepsCompleted, req.WeightKg, req.Notes, req.Status)
	switch {
	case errors.Is(err, workoutsvc.ErrNegativeSets),
		errors.Is(err, workoutsvc.ErrNegativeReps),
		errors.Is(err, workoutsvc.ErrNegativeWeight),
		errors.Is(err, workoutsvc.ErrInvalidExerciseLogStatus):
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
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

	if err := workoutsvc.ValidateExerciseValues(&req.TargetSets, &req.TargetRepsMin, req.TargetWeightKg); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// GetSession here is the ownership/existence guard for this auth-scoped
	// route; the log write + schedule propagation route through the service.
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

	source := req.Source
	if source == "" {
		source = "schedule"
	}
	if source != "schedule" && source != "library" {
		http.Error(w, "source must be 'schedule' or 'library'", http.StatusBadRequest)
		return
	}

	id, err := s.workoutSvc.AddExerciseToSession(
		req.SessionID, req.ExerciseID, req.ExerciseName,
		req.TargetSets, req.TargetRepsMin, req.TargetWeightKg,
		req.Status, req.Notes, source,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
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

	// GetSession is the ownership/existence guard for this auth-scoped route and
	// supplies NotificationMessageID for the transport-layer notification cleanup
	// below; the snooze state transition routes through the service.
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

	// GetSession here is the ownership/existence guard for this auth-scoped
	// route; the pre-skip state transition itself routes through the service.
	session, err := s.workouts.GetSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	if err := s.workoutSvc.PreSkipSession(id); err != nil {
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

	// GetSession here is the ownership/existence guard for this auth-scoped
	// route; the cancel-pre-skip transition itself routes through the service.
	session, err := s.workouts.GetSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	if err := s.workoutSvc.CancelPreSkipSession(id); err != nil {
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

	// GetSession here is the ownership/existence guard for this auth-scoped
	// route; the variant-selection logic itself routes through the service.
	session, err := s.workouts.GetSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != userID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	switch err := s.workoutSvc.NextVariant(id); {
	case err == nil:
		// proceed
	case errors.Is(err, workoutsvc.ErrSessionNotFound):
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	case errors.Is(err, workoutsvc.ErrVariantChangeNotAllowed):
		http.Error(w, "Cannot change variant for an active or completed session", http.StatusBadRequest)
		return
	case errors.Is(err, workoutsvc.ErrGroupNotFound):
		http.Error(w, "Workout group not found", http.StatusNotFound)
		return
	case errors.Is(err, workoutsvc.ErrGroupNotRotating):
		http.Error(w, "Workout group does not use rotation", http.StatusBadRequest)
		return
	default:
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

	// GetSession is the ownership/existence guard for this auth-scoped route and
	// supplies NotificationMessageID for the transport-layer notification cleanup
	// below; the skip + rotation advancement routes through the service.
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
			// Read-only loads to build the "workout started" notification text;
			// notification dispatch stays in the transport layer.
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

	outcome, err := s.workoutSvc.SetSessionStatus(id, req.Status)
	if errors.Is(err, workoutsvc.ErrInvalidSessionStatus) {
		http.Error(w, "Invalid status. Allowed values: in_progress, completed, skipped", http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if outcome == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	// For terminal states, clean up bot state and close the notification.
	// Notification dispatch stays in the transport layer.
	if outcome.Terminal {
		if s.workout != nil {
			s.workout.ClearPendingExercises(id)
			if err := s.workout.CleanupWorkoutSessionMessages(id); err != nil {
				slog.Error("Failed to cleanup workout messages for session", "sessionID", id, "error", err)
			}
		}
		if outcome.Session.NotificationMessageID != nil {
			s.deleteNotification(r.Context(), *outcome.Session.NotificationMessageID)
		}
		s.closeNotification(r.Context(), fmt.Sprintf("workout-%d", id))
	}

	w.WriteHeader(http.StatusOK)
}
