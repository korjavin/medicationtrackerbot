package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// -- Workout Group Handlers --

func (s *Server) handleListWorkoutGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.store.ListWorkoutGroups(s.allowedUserID, true)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(groups)
}

func (s *Server) handleCreateWorkoutGroup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name                       string `json:"name"`
		Description                string `json:"description"`
		IsRotating                 bool   `json:"is_rotating"`
		DaysOfWeek                 string `json:"days_of_week"` // JSON array as string
		ScheduledTime              string `json:"scheduled_time"`
		NotificationAdvanceMinutes int    `json:"notification_advance_minutes"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	group, err := s.store.CreateWorkoutGroup(
		req.Name,
		req.Description,
		req.IsRotating,
		s.allowedUserID,
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
	s.store.CreateGroupSnapshot(group.ID, snapshotData, "Initial setup")

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(group)
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.store.UpdateWorkoutGroup(
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
	s.store.CreateGroupSnapshot(id, snapshotData, "Settings updated")

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteWorkoutGroup(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid group ID", http.StatusBadRequest)
		return
	}

	// Simple implementation: just mark as inactive
	// A full delete would cascade to variants, exercises, sessions, etc.
	err = s.store.UpdateWorkoutGroup(id, "", "", false, "[]", "", 0, false)
	if err != nil {
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

	variants, err := s.store.ListVariantsByGroup(groupID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(variants)
}

func (s *Server) handleCreateWorkoutVariant(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GroupID       int64  `json:"group_id"`
		Name          string `json:"name"`
		RotationOrder *int   `json:"rotation_order"`
		Description   string `json:"description"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	variant, err := s.store.CreateWorkoutVariant(
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
	json.NewEncoder(w).Encode(variant)
}

func (s *Server) handleDeleteWorkoutVariant(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	_, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid variant ID", http.StatusBadRequest)
		return
	}

	// TODO: Implement proper delete with CASCADE
	http.Error(w, "Delete not yet fully implemented - would need CASCADE delete", http.StatusNotImplemented)
}

// -- Exercise Handlers --

func (s *Server) handleListExercisesByVariant(w http.ResponseWriter, r *http.Request) {
	variantIDStr := r.URL.Query().Get("variant_id")
	variantID, err := strconv.ParseInt(variantIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid variant ID", http.StatusBadRequest)
		return
	}

	exercises, err := s.store.ListExercisesByVariant(variantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(exercises)
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	exercise, err := s.store.AddExerciseToVariant(
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
	json.NewEncoder(w).Encode(exercise)
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
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.store.UpdateWorkoutExercise(
		id,
		req.ExerciseName,
		req.TargetSets,
		req.TargetRepsMin,
		req.TargetRepsMax,
		req.TargetWeightKg,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteExercise(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	_, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid exercise ID", http.StatusBadRequest)
		return
	}

	// TODO: Implement proper delete
	http.Error(w, "Delete not yet fully implemented", http.StatusNotImplemented)
}

// -- Session Handlers --

func (s *Server) handleListWorkoutSessions(w http.ResponseWriter, r *http.Request) {
	limitStr := r.URL.Query().Get("limit")
	limit := 30 // default
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil {
			limit = l
		}
	}

	sessions, err := s.store.GetWorkoutHistory(s.allowedUserID, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Enrich sessions with group and variant names
	type EnrichedSession struct {
		Session     interface{} `json:"session"`
		GroupName   string      `json:"group_name"`
		VariantName string      `json:"variant_name"`
		Exercises   int         `json:"exercises_count"`
		Completed   int         `json:"exercises_completed"`
		TotalVolume float64     `json:"total_volume"` // Total weight lifted (sets * reps * weight)
	}

	var enriched []EnrichedSession
	for _, session := range sessions {
		group, _ := s.store.GetWorkoutGroup(session.GroupID)
		variant, _ := s.store.GetWorkoutVariant(session.VariantID)
		logs, _ := s.store.GetExerciseLogs(session.ID)
		exercises, _ := s.store.ListExercisesByVariant(session.VariantID)

		groupName := "Unknown"
		variantName := "Unknown"
		if group != nil {
			groupName = group.Name
		}
		if variant != nil {
			variantName = variant.Name
		}

		completedCount := 0
		totalVolume := 0.0
		for _, log := range logs {
			if log.Status == "completed" {
				completedCount++
				// Calculate volume: sets * reps * weight
				if log.SetsCompleted != nil && log.RepsCompleted != nil && log.WeightKg != nil {
					volume := float64(*log.SetsCompleted) * float64(*log.RepsCompleted) * (*log.WeightKg)
					totalVolume += volume
				}
			}
		}

		enriched = append(enriched, EnrichedSession{
			Session:     session,
			GroupName:   groupName,
			VariantName: variantName,
			Exercises:   len(exercises),
			Completed:   completedCount,
			TotalVolume: totalVolume,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(enriched)
}

func (s *Server) handleGetSessionDetails(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}

	session, err := s.store.GetWorkoutSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	logs, err := s.store.GetExerciseLogs(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	response := struct {
		Session interface{} `json:"session"`
		Logs    interface{} `json:"logs"`
	}{
		Session: session,
		Logs:    logs,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (s *Server) handleGetNextWorkout(w http.ResponseWriter, r *http.Request) {
	// Get upcoming sessions (pending, notified, or in_progress)
	sessions, err := s.store.GetWorkoutHistory(s.allowedUserID, 100)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Get today's date (start of day in local time)
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())

	// Find all sessions that are pending/notified/in_progress AND scheduled for today or future
	var upcomingSessions []store.WorkoutSession
	for _, session := range sessions {
		// Skip if status is not pending/notified/in_progress
		if session.Status != "pending" && session.Status != "notified" && session.Status != "in_progress" {
			continue
		}

		// Check if session is scheduled for today or in the future
		sessionDate := time.Date(session.ScheduledDate.Year(), session.ScheduledDate.Month(), session.ScheduledDate.Day(), 0, 0, 0, 0, session.ScheduledDate.Location())

		if !sessionDate.Before(today) {
			upcomingSessions = append(upcomingSessions, session)
		}
	}

	// If no upcoming sessions, return null
	if len(upcomingSessions) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(nil)
		return
	}

	// Find the earliest upcoming session (since GetWorkoutHistory returns DESC order)
	nextSession := &upcomingSessions[0]
	for i := 1; i < len(upcomingSessions); i++ {
		if upcomingSessions[i].ScheduledDate.Before(nextSession.ScheduledDate) {
			nextSession = &upcomingSessions[i]
		}
	}

	// Enrich with group and variant names
	group, _ := s.store.GetWorkoutGroup(nextSession.GroupID)
	variant, _ := s.store.GetWorkoutVariant(nextSession.VariantID)
	exercises, _ := s.store.ListExercisesByVariant(nextSession.VariantID)

	groupName := "Unknown"
	variantName := "Unknown"
	if group != nil {
		groupName = group.Name
	}
	if variant != nil {
		variantName = variant.Name
	}

	response := struct {
		Session        interface{} `json:"session"`
		GroupName      string      `json:"group_name"`
		VariantName    string      `json:"variant_name"`
		ExercisesCount int         `json:"exercises_count"`
	}{
		Session:        nextSession,
		GroupName:      groupName,
		VariantName:    variantName,
		ExercisesCount: len(exercises),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// -- Stats Handlers --

func (s *Server) handleGetWorkoutStats(w http.ResponseWriter, r *http.Request) {
	// Get last 30 days of sessions
	since := time.Now().AddDate(0, 0, -30)
	sessions, err := s.store.GetWorkoutHistory(s.allowedUserID, 100)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Calculate stats
	totalSessions := 0
	completedSessions := 0
	skippedSessions := 0
	var streak int

	for _, session := range sessions {
		if session.ScheduledDate.Before(since) {
			continue
		}
		if session.Status == "completed" {
			completedSessions++
			totalSessions++
		} else if session.Status == "skipped" {
			skippedSessions++
			totalSessions++
		}
	}

	// Calculate current streak
	for _, session := range sessions {
		if session.Status == "completed" {
			streak++
		} else if session.Status == "skipped" || session.Status == "pending" {
			break
		}
	}

	stats := struct {
		TotalSessions     int     `json:"total_sessions"`
		CompletedSessions int     `json:"completed_sessions"`
		SkippedSessions   int     `json:"skipped_sessions"`
		CompletionRate    float64 `json:"completion_rate"`
		CurrentStreak     int     `json:"current_streak"`
	}{
		TotalSessions:     totalSessions,
		CompletedSessions: completedSessions,
		SkippedSessions:   skippedSessions,
		CompletionRate:    0,
		CurrentStreak:     streak,
	}

	if totalSessions > 0 {
		stats.CompletionRate = float64(completedSessions) / float64(totalSessions) * 100
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// -- Rotation Handlers --

func (s *Server) handleGetRotationState(w http.ResponseWriter, r *http.Request) {
	groupIDStr := r.URL.Query().Get("group_id")
	groupID, err := strconv.ParseInt(groupIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid group ID", http.StatusBadRequest)
		return
	}

	state, err := s.store.GetRotationState(groupID)
	if err != nil || state == nil {
		http.Error(w, "Rotation state not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(state)
}

func (s *Server) handleInitializeRotation(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GroupID           int64 `json:"group_id"`
		StartingVariantID int64 `json:"starting_variant_id"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err := s.store.InitializeRotation(req.GroupID, req.StartingVariantID)
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
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err := s.store.UpdateExerciseLog(req.ID, req.SetsCompleted, req.RepsCompleted, req.WeightKg, req.Notes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}
