package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.store.UpdateWorkoutVariant(id, req.Name, req.RotationOrder, req.Description)
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

	err = s.store.DeleteWorkoutVariant(id)
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
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid exercise ID", http.StatusBadRequest)
		return
	}

	err = s.store.DeleteWorkoutExercise(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
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
	now := time.Now()

	// Get all active workout groups
	groups, err := s.store.ListWorkoutGroups(s.allowedUserID, true)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var nextWorkout *struct {
		GroupID        int64
		GroupName      string
		VariantID      int64
		VariantName    string
		ScheduledDate  time.Time
		ScheduledTime  string
		ExercisesCount int
		Status         string
	}
	var earliestTime time.Time

	for _, group := range groups {
		// Parse days of week
		var daysOfWeek []int
		if err := json.Unmarshal([]byte(group.DaysOfWeek), &daysOfWeek); err != nil {
			continue
		}

		// Find the next occurrence of this workout
		for daysAhead := 0; daysAhead < 14; daysAhead++ { // Check next 2 weeks
			checkDate := now.AddDate(0, 0, daysAhead)
			dayOfWeek := int(checkDate.Weekday())

			if !contains(daysOfWeek, dayOfWeek) {
				continue
			}

			// Parse scheduled time
			var hour, minute int
			if _, err := fmt.Sscanf(group.ScheduledTime, "%d:%d", &hour, &minute); err != nil {
				continue
			}

			scheduledDateTime := time.Date(checkDate.Year(), checkDate.Month(), checkDate.Day(), hour, minute, 0, 0, now.Location())

			// Skip if this time has already passed
			if scheduledDateTime.Before(now) {
				continue
			}

			// Check if this is earlier than our current candidate
			if nextWorkout == nil || scheduledDateTime.Before(earliestTime) {
				// Determine variant
				var variantID int64
				if group.IsRotating {
					rotationState, _ := s.store.GetRotationState(group.ID)
					if rotationState != nil {
						variantID = rotationState.CurrentVariantID
					} else {
						variants, _ := s.store.ListVariantsByGroup(group.ID)
						if len(variants) > 0 {
							variantID = variants[0].ID
						}
					}
				} else {
					variants, _ := s.store.ListVariantsByGroup(group.ID)
					if len(variants) > 0 {
						variantID = variants[0].ID
					}
				}

				if variantID == 0 {
					continue
				}

				variant, _ := s.store.GetWorkoutVariant(variantID)
				if variant == nil {
					continue
				}

				exercises, _ := s.store.ListExercisesByVariant(variantID)

				// Check if there's an existing session for this date
				sessionDate := time.Date(checkDate.Year(), checkDate.Month(), checkDate.Day(), 0, 0, 0, 0, now.Location())
				existing, _ := s.store.GetSessionByGroupAndDate(group.ID, sessionDate)

				status := "pending"
				if existing != nil {
					status = existing.Status
				}

				nextWorkout = &struct {
					GroupID        int64
					GroupName      string
					VariantID      int64
					VariantName    string
					ScheduledDate  time.Time
					ScheduledTime  string
					ExercisesCount int
					Status         string
				}{
					GroupID:        group.ID,
					GroupName:      group.Name,
					VariantID:      variantID,
					VariantName:    variant.Name,
					ScheduledDate:  scheduledDateTime,
					ScheduledTime:  group.ScheduledTime,
					ExercisesCount: len(exercises),
					Status:         status,
				}
				earliestTime = scheduledDateTime
			}

			break // Found next occurrence for this group, move to next group
		}
	}

	if nextWorkout == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(nil)
		return
	}

	response := struct {
		Session        interface{} `json:"session"`
		GroupName      string      `json:"group_name"`
		VariantName    string      `json:"variant_name"`
		ExercisesCount int         `json:"exercises_count"`
	}{
		Session: map[string]interface{}{
			"scheduled_date": nextWorkout.ScheduledDate,
			"scheduled_time": nextWorkout.ScheduledTime,
			"status":         nextWorkout.Status,
		},
		GroupName:      nextWorkout.GroupName,
		VariantName:    nextWorkout.VariantName,
		ExercisesCount: nextWorkout.ExercisesCount,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// Helper function
func contains(slice []int, val int) bool {
	for _, item := range slice {
		if item == val {
			return true
		}
	}
	return false
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

func (s *Server) handleSnoozeWorkoutSession(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Minutes int `json:"minutes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Minutes <= 0 {
		req.Minutes = 60 // Default
	}

	err = s.store.SnoozeSession(id, time.Duration(req.Minutes)*time.Minute)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleSkipWorkoutSession(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	err = s.store.SkipSession(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}
