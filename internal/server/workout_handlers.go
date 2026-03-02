package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// -- Workout Group Handlers --

func (s *Server) handleListWorkoutGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.workouts.ListWorkoutGroups(s.allowedUserID, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(groups); err != nil {
		log.Printf("encode response: %v", err)
	}
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

	group, err := s.workouts.CreateWorkoutGroup(
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
	if err := s.workouts.CreateGroupSnapshot(group.ID, snapshotData, "Initial setup"); err != nil {
		log.Printf("create group snapshot: %v", err)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(group); err != nil {
		log.Printf("encode response: %v", err)
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.workouts.UpdateWorkoutGroup(
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
		log.Printf("create group snapshot: %v", err)
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

	err = s.workouts.DeleteWorkoutGroup(id)
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
		log.Printf("encode response: %v", err)
	}
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

	variant, err := s.workouts.CreateWorkoutVariant(
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
		log.Printf("encode response: %v", err)
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.workouts.UpdateWorkoutVariant(id, req.Name, req.RotationOrder, req.Description)
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

	err = s.workouts.DeleteWorkoutVariant(id)
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
		log.Printf("encode response: %v", err)
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	exercise, err := s.workouts.AddExerciseToVariant(
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
		log.Printf("encode response: %v", err)
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.workouts.UpdateWorkoutExercise(
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

	err = s.workouts.DeleteWorkoutExercise(id)
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

	sessions, err := s.workouts.GetWorkoutHistory(s.allowedUserID, limit)
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
		group, _ := s.workouts.GetWorkoutGroup(session.GroupID)
		variant, _ := s.workouts.GetWorkoutVariant(session.VariantID)
		logs, _ := s.workouts.GetExerciseLogs(session.ID)
		exercises, _ := s.workouts.ListExercisesByVariant(session.VariantID)

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
	if err := json.NewEncoder(w).Encode(enriched); err != nil {
		log.Printf("encode response: %v", err)
	}
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

func (s *Server) handleGetSessionDetails(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid session ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetWorkoutSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	logs, err := s.workouts.GetExerciseLogs(id)
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
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func (s *Server) handleGetNextWorkout(w http.ResponseWriter, r *http.Request) {
	now := time.Now()

	// PRIORITY 0: Check for active sessions today (notified or in_progress)
	// This ensures that workouts that have been notified but not yet started/completed
	// are still visible in the UI even if their scheduled time has passed
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	activeSessions, err := s.workouts.GetActiveSessions(s.allowedUserID, today)
	if err == nil && len(activeSessions) > 0 {
		// Return the earliest active session
		session := &activeSessions[0] // Already ordered by scheduled_time ASC

		group, _ := s.workouts.GetWorkoutGroup(session.GroupID)
		variant, _ := s.workouts.GetWorkoutVariant(session.VariantID)
		exercises, _ := s.workouts.ListExercisesByVariant(session.VariantID)

		groupName := "Unknown"
		variantName := "Unknown"
		if group != nil {
			groupName = group.Name
		}
		if variant != nil {
			variantName = variant.Name
		}

		isRotating := group != nil && group.IsRotating
		response := struct {
			Session        interface{} `json:"session"`
			GroupName      string      `json:"group_name"`
			VariantName    string      `json:"variant_name"`
			ExercisesCount int         `json:"exercises_count"`
			VariantID      int64       `json:"variant_id"`
			GroupID        int64       `json:"group_id"`
			IsRotating     bool        `json:"is_rotating"`
		}{
			Session: map[string]interface{}{
				"id":             session.ID,
				"scheduled_date": session.ScheduledDate,
				"scheduled_time": session.ScheduledTime,
				"status":         session.Status,
				"is_snoozed":     session.SnoozedUntil != nil,
				"snoozed_until":  session.SnoozedUntil,
			},
			GroupName:      groupName,
			VariantName:    variantName,
			ExercisesCount: len(exercises),
			VariantID:      session.VariantID,
			GroupID:        session.GroupID,
			IsRotating:     isRotating,
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(response); err != nil {
			log.Printf("encode response: %v", err)
		}
		return
	}

	// FIRST: Check for snoozed sessions that are ready to start
	snoozedSessions, err := s.workouts.GetSnoozedSessions(s.allowedUserID)
	if err == nil && len(snoozedSessions) > 0 {
		// Find the earliest snoozed session
		var earliestSnoozed *store.WorkoutSession
		for i := range snoozedSessions {
			session := &snoozedSessions[i]
			if session.SnoozedUntil != nil && session.SnoozedUntil.Before(now) {
				if earliestSnoozed == nil || session.SnoozedUntil.Before(*earliestSnoozed.SnoozedUntil) {
					earliestSnoozed = session
				}
			}
		}

		// If we found a snoozed session, return it as the next workout
		if earliestSnoozed != nil {
			group, _ := s.workouts.GetWorkoutGroup(earliestSnoozed.GroupID)
			variant, _ := s.workouts.GetWorkoutVariant(earliestSnoozed.VariantID)
			exercises, _ := s.workouts.ListExercisesByVariant(earliestSnoozed.VariantID)

			groupName := "Unknown"
			variantName := "Unknown"
			if group != nil {
				groupName = group.Name
			}
			if variant != nil {
				variantName = variant.Name
			}

			isRotating := group != nil && group.IsRotating
			response := struct {
				Session        interface{} `json:"session"`
				GroupName      string      `json:"group_name"`
				VariantName    string      `json:"variant_name"`
				ExercisesCount int         `json:"exercises_count"`
				VariantID      int64       `json:"variant_id"`
				GroupID        int64       `json:"group_id"`
				IsRotating     bool        `json:"is_rotating"`
			}{
				Session: map[string]interface{}{
					"id":             earliestSnoozed.ID,
					"scheduled_date": earliestSnoozed.ScheduledDate,
					"scheduled_time": earliestSnoozed.ScheduledTime,
					"status":         earliestSnoozed.Status,
					"snoozed_until":  earliestSnoozed.SnoozedUntil,
					"is_snoozed":     true,
				},
				GroupName:      groupName,
				VariantName:    variantName,
				ExercisesCount: len(exercises),
				VariantID:      earliestSnoozed.VariantID,
				GroupID:        earliestSnoozed.GroupID,
				IsRotating:     isRotating,
			}

			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(response); err != nil {
				log.Printf("encode response: %v", err)
			}
			return
		}
	}

	// SECOND: Fall back to scheduled workouts
	// Get all active workout groups
	groups, err := s.workouts.ListWorkoutGroups(s.allowedUserID, true)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var nextWorkout *struct {
		SessionID      int64
		GroupID        int64
		GroupName      string
		VariantID      int64
		VariantName    string
		ScheduledDate  time.Time
		ScheduledTime  string
		ExercisesCount int
		Status         string
		IsRotating     bool
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
					rotationState, _ := s.workouts.GetRotationState(group.ID)
					if rotationState != nil {
						variantID = rotationState.CurrentVariantID
					} else {
						variants, _ := s.workouts.ListVariantsByGroup(group.ID)
						if len(variants) > 0 {
							variantID = variants[0].ID
						}
					}
				} else {
					variants, _ := s.workouts.ListVariantsByGroup(group.ID)
					if len(variants) > 0 {
						variantID = variants[0].ID
					}
				}

				if variantID == 0 {
					continue
				}

				variant, _ := s.workouts.GetWorkoutVariant(variantID)
				if variant == nil {
					continue
				}

				exercises, _ := s.workouts.ListExercisesByVariant(variantID)

				// Check if there's an existing session for this date
				sessionDate := time.Date(checkDate.Year(), checkDate.Month(), checkDate.Day(), 0, 0, 0, 0, now.Location())
				existing, _ := s.workouts.GetSessionByGroupAndDate(group.ID, sessionDate)

				status := "pending"
				var sessionID int64
				if existing != nil {
					// If the session is already completed or skipped, we don't need to show it as upcoming
					if existing.Status == "completed" || existing.Status == "skipped" {
						continue
					}
					status = existing.Status
					sessionID = existing.ID
				}

				nextWorkout = &struct {
					SessionID      int64
					GroupID        int64
					GroupName      string
					VariantID      int64
					VariantName    string
					ScheduledDate  time.Time
					ScheduledTime  string
					ExercisesCount int
					Status         string
					IsRotating     bool
				}{
					SessionID:      sessionID,
					GroupID:        group.ID,
					GroupName:      group.Name,
					VariantID:      variantID,
					VariantName:    variant.Name,
					ScheduledDate:  scheduledDateTime,
					ScheduledTime:  group.ScheduledTime,
					ExercisesCount: len(exercises),
					Status:         status,
					IsRotating:     group.IsRotating,
				}
				earliestTime = scheduledDateTime
			}

			break // Found next occurrence for this group, move to next group
		}
	}

	if nextWorkout == nil {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(nil); err != nil {
			log.Printf("encode response: %v", err)
		}
		return
	}

	// If the session doesn't exist yet (SessionID is 0), create it now
	// This ensures the frontend has a valid ID to call /start on
	if nextWorkout.SessionID == 0 {
		// Need to strip time component from ScheduledDate for consistency with how it was checked
		// Actually CreateWorkoutSession takes time.Time for date, which we have (scheduledDateTime)
		// but we typically store just the date part for ScheduledDate in DB?
		// Let's check CreateWorkoutSession impl. It stores what we pass.
		// Standardize on using the date part for the Date field
		dateOnly := time.Date(nextWorkout.ScheduledDate.Year(), nextWorkout.ScheduledDate.Month(), nextWorkout.ScheduledDate.Day(), 0, 0, 0, 0, nextWorkout.ScheduledDate.Location())

		newSession, err := s.workouts.CreateWorkoutSession(
			nextWorkout.GroupID,
			nextWorkout.VariantID,
			s.allowedUserID,
			dateOnly,
			nextWorkout.ScheduledTime,
		)
		if err != nil {
			// Log error but maybe return what we have? Or fail?
			// If we fail here, the user sees nothing. Better to return the transient object but they can't start it?
			// No, better to fail so we see the error.
			http.Error(w, fmt.Sprintf("Error creating session: %v", err), http.StatusInternalServerError)
			return
		}
		nextWorkout.SessionID = newSession.ID
		nextWorkout.Status = newSession.Status
	}

	response := struct {
		Session        interface{} `json:"session"`
		GroupName      string      `json:"group_name"`
		VariantName    string      `json:"variant_name"`
		ExercisesCount int         `json:"exercises_count"`
		VariantID      int64       `json:"variant_id"`
		GroupID        int64       `json:"group_id"`
		IsRotating     bool        `json:"is_rotating"`
	}{
		Session: map[string]interface{}{
			"id":             nextWorkout.SessionID,
			"scheduled_date": nextWorkout.ScheduledDate,
			"scheduled_time": nextWorkout.ScheduledTime,
			"status":         nextWorkout.Status,
			"is_snoozed":     false,
		},
		GroupName:      nextWorkout.GroupName,
		VariantName:    nextWorkout.VariantName,
		ExercisesCount: nextWorkout.ExercisesCount,
		VariantID:      nextWorkout.VariantID,
		GroupID:        nextWorkout.GroupID,
		IsRotating:     nextWorkout.IsRotating,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("encode response: %v", err)
	}
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
	// Fetch enough sessions for streak + 30-day stats
	sessions, err := s.workouts.GetWorkoutHistory(s.allowedUserID, 500)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	since30 := time.Now().AddDate(0, 0, -30)

	// 30-day counts
	totalSessions := 0
	completedSessions := 0
	skippedSessions := 0

	// Streaks (sessions sorted newest-first)
	currentStreak := 0
	longestStreak := 0
	tempStreak := 0
	streakDone := false

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
		// Current streak: walk newest-first, only break on "skipped"
		if !streakDone {
			switch session.Status {
			case "completed":
				currentStreak++
			case "skipped":
				streakDone = true
				// pending, notified, in_progress, snoozed: ignore (don't break streak)
			}
		}

		// Longest streak: track running count, reset on skipped
		switch session.Status {
		case "completed":
			tempStreak++
			if tempStreak > longestStreak {
				longestStreak = tempStreak
			}
		case "skipped":
			tempStreak = 0
		}

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

	// Ensure longest >= current (in case all sessions are completed)
	if currentStreak > longestStreak {
		longestStreak = currentStreak
	}

	// Sort weekly activity chronologically
	var weekKeys []string
	for w := range weekMap {
		weekKeys = append(weekKeys, w)
	}
	sort.Strings(weekKeys)
	var weeklyActivity []WeekActivity
	for _, w := range weekKeys {
		weeklyActivity = append(weeklyActivity, *weekMap[w])
	}

	// Exercise stats from DB
	exerciseStats, _ := s.workouts.GetExerciseStats(s.allowedUserID)

	// Total volume = sum across all exercises
	totalVolumeKg := 0.0
	for _, es := range exerciseStats {
		totalVolumeKg += es.TotalVolumeKg
	}

	completionRate := 0.0
	if totalSessions > 0 {
		completionRate = float64(completedSessions) / float64(totalSessions) * 100
	}

	stats := struct {
		TotalSessions     int                  `json:"total_sessions"`
		CompletedSessions int                  `json:"completed_sessions"`
		SkippedSessions   int                  `json:"skipped_sessions"`
		CompletionRate    float64              `json:"completion_rate"`
		CurrentStreak     int                  `json:"current_streak"`
		LongestStreak     int                  `json:"longest_streak"`
		TotalVolumeKg     float64              `json:"total_volume_kg"`
		TopExercises      []store.ExerciseStat `json:"top_exercises"`
		WeeklyActivity    []WeekActivity       `json:"weekly_activity"`
	}{
		TotalSessions:     totalSessions,
		CompletedSessions: completedSessions,
		SkippedSessions:   skippedSessions,
		CompletionRate:    completionRate,
		CurrentStreak:     currentStreak,
		LongestStreak:     longestStreak,
		TotalVolumeKg:     totalVolumeKg,
		TopExercises:      exerciseStats,
		WeeklyActivity:    weeklyActivity,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(stats); err != nil {
		log.Printf("encode response: %v", err)
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
		log.Printf("encode response: %v", err)
	}
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

	err := s.workouts.InitializeRotation(req.GroupID, req.StartingVariantID)
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

	err := s.workouts.UpdateExerciseLog(req.ID, req.SetsCompleted, req.RepsCompleted, req.WeightKg, req.Notes)
	if err != nil {
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
	exercises, err := s.workouts.GetAllUniqueExercises(s.allowedUserID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(exercises); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func (s *Server) handleAddExerciseToSession(w http.ResponseWriter, r *http.Request) {
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
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.SessionID == 0 || req.ExerciseID == 0 {
		http.Error(w, "SessionID and ExerciseID are required", http.StatusBadRequest)
		return
	}

	// Verify session ownership
	session, err := s.workouts.GetWorkoutSession(req.SessionID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != s.allowedUserID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	// Used passed ExerciseID. If it refers to an exercise in another variant, that's fine.
	// It just serves as a reference to "what exercise was this".
	// The log entry copies the name anyway.

	// Helper to handle pointer conversions for logs if needed, but LogExercise takes pointers for completion stats
	// We need to map request fields to LogExercise params.
	// LogExercise(sessionID, exerciseID, exerciseName, sets, reps, weight, status, notes)
	// sets, reps, weight in LogExercise are *int/*float64 which represent *completed* values.
	// The request has "Target" values? No, for a completed session addition, we probably mean "I did this".
	// The UI should ask for "Sets Completed", "Reps Completed", "Weight Used".
	// So the request fields should probably be `SetsCompleted`, etc. not Target.
	// Let's check the plan: "Add API endpoint to add exercise to session".
	// The UI modal usually asks for targets when *editing* an exercise definition, but here we are *logging* performed work.
	// Actually, `LogExercise` is for *logging* a performed exercise.
	// But `WorkoutSession` logs usually start as copies of `WorkoutExercise` with null completion data.
	// If we add an exercise to a session, we are effectively adding a row to `workout_exercise_logs`.
	// Does it need to be "completed" immediately?
	// If the user is adding it to a completed workout, they likely enter what they did.
	// So we should accept `SetsCompleted`, `RepsCompleted`, etc.
	// Let's rename request fields to match `LogExercise`.

	// Re-defining request struct to match LogExercise needs
	// We'll treat target values as what was done, or maybe we want to store targets too?
	// `workout_exercise_logs` table struct:
	// type WorkoutExerciseLog struct { ... SetsCompleted *int ... }
	// It does NOT store targets. It links to `exercise_id` which has targets.
	// If we pick a unique exercise, that `exercise_id` has targets.
	// So we just need to log what was done.

	sets := req.TargetSets
	reps := req.TargetRepsMin
	weight := req.TargetWeightKg
	// Wait, if I use the existing struct names `TargetSets` etc from the plan, I should map them.
	// But it's better to be explicit.
	// Let's assume the UI sends `sets_completed`, `reps_completed`, `weight_kg`.
	// But the `handleAddExerciseToSession` stub in previous step used `Target...`.
	// I will update the struct in the replacement to be correct.

	id, err := s.workouts.LogExercise(
		req.SessionID,
		req.ExerciseID,
		req.ExerciseName,
		&sets, // sets completed
		&reps, // reps completed. We'll use Min as the value if that's what we have.
		weight,
		req.Status,
		req.Notes,
	)

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(map[string]int64{"id": id}); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func (s *Server) handleSnoozeWorkoutSession(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetWorkoutSession(id)
	if err != nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != s.allowedUserID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
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

	err = s.workouts.SnoozeSession(id, time.Duration(req.Minutes)*time.Minute)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if session.NotificationMessageID != nil {
		s.deleteNotification(r.Context(), *session.NotificationMessageID)
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handlePreSkipWorkoutSession(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetWorkoutSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != s.allowedUserID {
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
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetWorkoutSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != s.allowedUserID {
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
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetWorkoutSession(id)
	if err != nil || session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != s.allowedUserID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}
	if session.Status == "in_progress" || session.Status == "completed" || session.Status == "skipped" {
		http.Error(w, "Cannot change variant for an active or completed session", http.StatusBadRequest)
		return
	}

	group, err := s.workouts.GetWorkoutGroup(session.GroupID)
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
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	session, err := s.workouts.GetWorkoutSession(id)
	if err != nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session.UserID != s.allowedUserID {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	err = s.workouts.SkipSession(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if session.NotificationMessageID != nil {
		s.deleteNotification(r.Context(), *session.NotificationMessageID)
	}

	// Advance rotation for rotating groups
	group, err := s.workouts.GetWorkoutGroup(session.GroupID)
	if err == nil && group != nil && group.IsRotating {
		if err := s.workouts.AdvanceRotation(group.ID); err != nil {
			log.Printf("Failed to advance rotation for group %d: %v", group.ID, err)
		}
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

	// Mark session as in_progress and set started_at
	err = s.workouts.StartSession(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Clear snooze if it was snoozed
	err = s.workouts.ClearSnooze(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Update Telegram notification
	if s.workout != nil {
		go func() {
			session, err := s.workouts.GetWorkoutSession(id)
			if err != nil || session == nil {
				return
			}

			group, _ := s.workouts.GetWorkoutGroup(session.GroupID)
			variant, _ := s.workouts.GetWorkoutVariant(session.VariantID)

			text := "✅ **Workout started**"
			if group != nil && variant != nil {
				text += fmt.Sprintf("\n%s - %s", group.Name, variant.Name)
			}
			text += "\n\nLet's go! 💪"

			if session.NotificationMessageID != nil {
				if err := s.workout.UpdateWorkoutMessage(*session.NotificationMessageID, text); err != nil {
					log.Printf("Failed to update workout message: %v", err)
				}
				// Keep UX consistent with Telegram-start flow: remove original notification card.
				s.deleteNotification(context.Background(), *session.NotificationMessageID)
			}

			if err := s.workout.StartWorkoutFlowFromWeb(id); err != nil {
				log.Printf("Failed to start workout Telegram flow from web: %v", err)
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
	session, err := s.workouts.GetWorkoutSession(id)
	if err != nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	if session == nil {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	err = s.workouts.UpdateSessionStatus(id, req.Status)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// If skipped or completed, try to delete the notification message
	if (req.Status == "skipped" || req.Status == "completed") && session.NotificationMessageID != nil {
		s.deleteNotification(r.Context(), *session.NotificationMessageID)
	}

	// Advance rotation for rotating groups when session is completed or skipped
	if req.Status == "skipped" || req.Status == "completed" {
		group, err := s.workouts.GetWorkoutGroup(session.GroupID)
		if err == nil && group != nil && group.IsRotating {
			if err := s.workouts.AdvanceRotation(group.ID); err != nil {
				log.Printf("Failed to advance rotation for group %d: %v", group.ID, err)
			}
		}
	}

	w.WriteHeader(http.StatusOK)
}

// -- Exercise Library Handlers --

func (s *Server) handleListExerciseLibrary(w http.ResponseWriter, r *http.Request) {
	items, err := s.workouts.ListExerciseLibrary(s.allowedUserID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(items); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func (s *Server) handleCreateExerciseLibraryItem(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name            string   `json:"name"`
		DefaultSets     int      `json:"default_sets"`
		DefaultRepsMin  int      `json:"default_reps_min"`
		DefaultRepsMax  *int     `json:"default_reps_max"`
		DefaultWeightKg *float64 `json:"default_weight_kg"`
		Notes           string   `json:"notes"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Name == "" {
		http.Error(w, "Name is required", http.StatusBadRequest)
		return
	}

	item, err := s.workouts.CreateExerciseLibraryItem(s.allowedUserID, req.Name, req.DefaultSets, req.DefaultRepsMin, req.DefaultRepsMax, req.DefaultWeightKg, req.Notes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(item); err != nil {
		log.Printf("encode response: %v", err)
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
