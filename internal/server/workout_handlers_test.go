package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

func TestHandleUpdateSessionStatus(t *testing.T) {
	// Create test database
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	// Create test server
	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		allowedUserID: 123456,
	}

	// Create test user, medication, and workout structures
	userID := int64(123456)

	// Create workout group
	group, err := db.CreateWorkoutGroup("Test Group", "Test", false, userID, "[1,2,3,4,5]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	// Create variant
	rotationOrder := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Test Variant", &rotationOrder, "")
	if err != nil {
		t.Fatalf("Failed to create workout variant: %v", err)
	}

	// Create a workout session
	scheduledDate := time.Now()
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, scheduledDate, "09:00")
	if err != nil {
		t.Fatalf("Failed to create workout session: %v", err)
	}

	// Initially set status to completed
	err = db.UpdateSessionStatus(session.ID, "completed")
	if err != nil {
		t.Fatalf("Failed to set initial status: %v", err)
	}

	tests := []struct {
		name           string
		sessionID      int64
		reqBody        map[string]string
		expectedStatus int
		expectedError  string
		finalStatus    string
	}{
		{
			name:           "Valid status update to skipped",
			sessionID:      session.ID,
			reqBody:        map[string]string{"status": "skipped"},
			expectedStatus: http.StatusOK,
			finalStatus:    "skipped",
		},
		{
			name:           "Valid status update to completed",
			sessionID:      session.ID,
			reqBody:        map[string]string{"status": "completed"},
			expectedStatus: http.StatusOK,
			finalStatus:    "completed",
		},
		{
			name:           "Invalid status value",
			sessionID:      session.ID,
			reqBody:        map[string]string{"status": "pending"},
			expectedStatus: http.StatusBadRequest,
			expectedError:  "Invalid status",
		},
		{
			name:           "Valid status update to in_progress",
			sessionID:      session.ID,
			reqBody:        map[string]string{"status": "in_progress"},
			expectedStatus: http.StatusOK,
			finalStatus:    "in_progress",
		},
		{
			name:           "Non-existent session ID",
			sessionID:      99999,
			reqBody:        map[string]string{"status": "completed"},
			expectedStatus: http.StatusNotFound,
		},
		{
			name:           "Session ID 0",
			sessionID:      0,
			reqBody:        map[string]string{"status": "completed"},
			expectedStatus: http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Prepare request body
			bodyBytes, _ := json.Marshal(tt.reqBody)
			url := fmt.Sprintf("/api/workout/sessions/status?id=%d", tt.sessionID)
			req := httptest.NewRequest(http.MethodPut, url, bytes.NewReader(bodyBytes))

			w := httptest.NewRecorder()

			// Call handler
			srv.handleUpdateSessionStatus(w, req)

			// Check status code
			if w.Code != tt.expectedStatus {
				t.Errorf("Expected status %d, got %d. Body: %s", tt.expectedStatus, w.Code, w.Body.String())
			}

			// Check error message if expected
			if tt.expectedError != "" && !bytes.Contains(w.Body.Bytes(), []byte(tt.expectedError)) {
				t.Errorf("Expected error containing %q, got %q", tt.expectedError, w.Body.String())
			}

			// Verify final status if test should succeed
			if tt.expectedStatus == http.StatusOK && tt.finalStatus != "" {
				updatedSession, err := db.GetWorkoutSession(session.ID)
				if err != nil {
					t.Fatalf("Failed to get updated session: %v", err)
				}
				if updatedSession.Status != tt.finalStatus {
					t.Errorf("Expected final status %q, got %q", tt.finalStatus, updatedSession.Status)
				}
			}
		})
	}
}

type workoutInteractorSpy struct {
	cleaned        []int64
	pendingCleared []int64
}

func (w *workoutInteractorSpy) UpdateWorkoutMessage(_ int, _ string) error {
	return nil
}

func (w *workoutInteractorSpy) StartWorkoutFlowFromWeb(_ int64) error {
	return nil
}

func (w *workoutInteractorSpy) CleanupWorkoutSessionMessages(sessionID int64) error {
	w.cleaned = append(w.cleaned, sessionID)
	return nil
}

func (w *workoutInteractorSpy) ClearPendingExercises(sessionID int64) {
	w.pendingCleared = append(w.pendingCleared, sessionID)
}

func TestHandleUpdateSessionStatus_CleansUpWorkoutChatOnTerminalState(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	spy := &workoutInteractorSpy{}
	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		workout:       spy,
		allowedUserID: 123456,
	}

	userID := int64(123456)
	group, err := db.CreateWorkoutGroup("Test Group", "Test", false, userID, "[1,2,3,4,5]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}
	variant, err := db.CreateWorkoutVariant(group.ID, "Test Variant", nil, "")
	if err != nil {
		t.Fatalf("Failed to create workout variant: %v", err)
	}
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("Failed to create workout session: %v", err)
	}

	bodyBytes, _ := json.Marshal(map[string]string{"status": "completed"})
	req := httptest.NewRequest(http.MethodPut, fmt.Sprintf("/api/workout/sessions/status?id=%d", session.ID), bytes.NewReader(bodyBytes))
	w := httptest.NewRecorder()

	srv.handleUpdateSessionStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	if len(spy.cleaned) != 1 || spy.cleaned[0] != session.ID {
		t.Fatalf("expected workout chat cleanup for session %d, got %v", session.ID, spy.cleaned)
	}

	if len(spy.pendingCleared) != 1 || spy.pendingCleared[0] != session.ID {
		t.Fatalf("expected pending exercises cleared for session %d, got %v", session.ID, spy.pendingCleared)
	}
}

func TestHandleSnoozeWorkoutSessionCompat(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		allowedUserID: 123456,
	}

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Test", "Test", false, userID, "[1,2,3,4,5]", "09:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "A", nil, "")
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	reqBody := map[string]interface{}{
		"session_id":     session.ID,
		"duration_hours": 1,
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/workout/session/snooze", bytes.NewReader(bodyBytes))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleSnoozeWorkoutSessionCompat(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	updated, _ := db.GetWorkoutSession(session.ID)
	if updated.SnoozedUntil == nil {
		t.Errorf("Expected session to be snoozed")
	}
}

func TestHandleSkipWorkoutSessionCompat(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	spy := &workoutInteractorSpy{}
	userID := int64(123456)
	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		workout:       spy,
		allowedUserID: userID,
	}

	group, _ := db.CreateWorkoutGroup("Test", "Test", false, userID, "[1,2,3,4,5]", "09:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "A", nil, "")
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	reqBody := map[string]interface{}{
		"session_id": session.ID,
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req := httptest.NewRequest(http.MethodPost, "/api/workout/session/skip", bytes.NewReader(bodyBytes))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleSkipWorkoutSessionCompat(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	updated, _ := db.GetWorkoutSession(session.ID)
	if updated.Status != "skipped" {
		t.Errorf("Expected session status to be 'skipped', got %s", updated.Status)
	}

	if len(spy.cleaned) != 1 || spy.cleaned[0] != session.ID {
		t.Fatalf("expected workout chat cleanup for session %d, got %v", session.ID, spy.cleaned)
	}
	if len(spy.pendingCleared) != 1 || spy.pendingCleared[0] != session.ID {
		t.Fatalf("expected pending exercises cleared for session %d, got %v", session.ID, spy.pendingCleared)
	}
}

func TestHandleSkipWorkoutSession_ClearsPendingExercises(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	spy := &workoutInteractorSpy{}
	userID := int64(123456)
	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		workout:       spy,
		allowedUserID: userID,
	}

	group, _ := db.CreateWorkoutGroup("Test", "Test", false, userID, "[1,2,3,4,5]", "09:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "A", nil, "")
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/workout/sessions/%d/skip", session.ID), nil)
	req.SetPathValue("id", fmt.Sprintf("%d", session.ID))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleSkipWorkoutSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	if len(spy.cleaned) != 1 || spy.cleaned[0] != session.ID {
		t.Fatalf("expected workout chat cleanup for session %d, got %v", session.ID, spy.cleaned)
	}
	if len(spy.pendingCleared) != 1 || spy.pendingCleared[0] != session.ID {
		t.Fatalf("expected pending exercises cleared for session %d, got %v", session.ID, spy.pendingCleared)
	}
}

func TestHandleGetNextWorkout_LazyCreation(t *testing.T) {
	// Create test database
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	// Create test server
	userID := int64(123456)
	srv := &Server{
		workouts:      db,
		allowedUserID: userID,
	}

	// Create workout group active every day at 23:59 (to ensure it's in future for today, or definitely tomorrow)
	// We want to test that it picks up *some* future workout.
	// We'll use tomorrow to be safe from "time passed today" logic.
	group, err := db.CreateWorkoutGroup("Everyday Group", "Test", false, userID, "[0,1,2,3,4,5,6]", "23:59", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	// Create variant
	rotationOrder := 0
	_, err = db.CreateWorkoutVariant(group.ID, "Variant A", &rotationOrder, "")
	if err != nil {
		t.Fatalf("Failed to create workout variant: %v", err)
	}

	// Verify NO sessions exist initially
	sessions, err := db.GetWorkoutHistory(userID, 100)
	if err != nil {
		t.Fatalf("Failed to get history: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("Expected 0 sessions initially, got %d", len(sessions))
	}

	// Call handleGetNextWorkout
	req := withUser(httptest.NewRequest(http.MethodGet, "/api/workout/sessions/next", nil), userID)
	w := httptest.NewRecorder()

	srv.handleGetNextWorkout(w, req)

	// Check status code
	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Parse response
	var resp struct {
		Session struct {
			ID            int64  `json:"id"`
			Status        string `json:"status"`
			ScheduledTime string `json:"scheduled_time"`
		} `json:"session"`
		GroupName string `json:"group_name"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	// Verify session ID is not 0
	if resp.Session.ID == 0 {
		t.Error("Expected session ID > 0, got 0")
	}

	// Verify session was created in DB
	// Check history again
	sessions, err = db.GetWorkoutHistory(userID, 100)
	if err != nil {
		t.Fatalf("Failed to get history: %v", err)
	}
	if len(sessions) != 1 {
		t.Errorf("Expected 1 session created, got %d", len(sessions))
	} else {
		createdSession := sessions[0]
		if createdSession.ID != resp.Session.ID {
			t.Errorf("DB session ID %d does not match response ID %d", createdSession.ID, resp.Session.ID)
		}
		if createdSession.GroupID != group.ID {
			t.Errorf("Expected group ID %d, got %d", group.ID, createdSession.GroupID)
		}
		// Status should be pending
		if createdSession.Status != "pending" {
			t.Errorf("Expected status 'pending', got %q", createdSession.Status)
		}
	}
}

func TestHandleUpdateExerciseLog_PropagatesWeightToSchedule(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	userID := int64(123456)
	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		allowedUserID: userID,
	}

	// Create group → variant → exercise → session → log
	group, err := db.CreateWorkoutGroup("Push", "Push day", false, userID, "[1,2,3,4,5]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	rotOrder := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Day A", &rotOrder, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}
	weightKg := 60.0
	exercise, err := db.AddExerciseToVariant(variant.ID, "Bench Press", 3, 8, nil, &weightKg, 0)
	if err != nil {
		t.Fatalf("AddExerciseToVariant: %v", err)
	}

	// Create a pending session
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}

	// Log exercise
	logID, err := db.LogExercise(session.ID, exercise.ID, "Bench Press", intPtr(3), intPtr(8), &weightKg, "completed", "")
	if err != nil {
		t.Fatalf("LogExercise: %v", err)
	}

	// Now update the log with new weight
	newWeight := 65.0
	newSets := 4
	newReps := 10
	body, _ := json.Marshal(map[string]interface{}{
		"id":             logID,
		"sets_completed": newSets,
		"reps_completed": newReps,
		"weight_kg":      newWeight,
	})

	req := httptest.NewRequest(http.MethodPut, "/api/workout/exercises/log/update", bytes.NewReader(body))
	w := httptest.NewRecorder()

	srv.handleUpdateExerciseLog(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify workout_exercises schedule was updated
	exercises, _ := db.ListExercisesByVariant(variant.ID)
	if len(exercises) != 1 {
		t.Fatalf("Expected 1 exercise, got %d", len(exercises))
	}
	ex := exercises[0]
	if ex.TargetSets != newSets {
		t.Errorf("Expected target_sets=%d, got %d", newSets, ex.TargetSets)
	}
	if ex.TargetRepsMin != newReps {
		t.Errorf("Expected target_reps_min=%d, got %d", newReps, ex.TargetRepsMin)
	}
	if ex.TargetWeightKg == nil || *ex.TargetWeightKg != newWeight {
		t.Errorf("Expected target_weight_kg=%f, got %v", newWeight, ex.TargetWeightKg)
	}
}

func TestHandleUpdateExerciseLog_NoPropagate_CompletedSession(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	userID := int64(123456)
	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		allowedUserID: userID,
	}

	group, err := db.CreateWorkoutGroup("Push", "Push day", false, userID, "[1,2,3,4,5]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	rotOrder := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Day A", &rotOrder, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}
	weightKg := 60.0
	exercise, err := db.AddExerciseToVariant(variant.ID, "Bench Press", 3, 8, nil, &weightKg, 0)
	if err != nil {
		t.Fatalf("AddExerciseToVariant: %v", err)
	}

	session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}
	if err := db.UpdateSessionStatus(session.ID, "completed"); err != nil {
		t.Fatalf("UpdateSessionStatus: %v", err)
	}

	logID, err := db.LogExercise(session.ID, exercise.ID, "Bench Press", intPtr(3), intPtr(8), &weightKg, "completed", "")
	if err != nil {
		t.Fatalf("LogExercise: %v", err)
	}

	newWeight := 80.0
	body, _ := json.Marshal(map[string]interface{}{
		"id":        logID,
		"weight_kg": newWeight,
	})

	req := httptest.NewRequest(http.MethodPut, "/api/workout/exercises/log/update", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.handleUpdateExerciseLog(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	// Verify schedule was NOT updated (session is completed)
	exercises, err := db.ListExercisesByVariant(variant.ID)
	if err != nil {
		t.Fatalf("ListExercisesByVariant: %v", err)
	}
	ex := exercises[0]
	if ex.TargetSets != 3 {
		t.Errorf("Expected target_sets to remain 3, got %d", ex.TargetSets)
	}
	if ex.TargetRepsMin != 8 {
		t.Errorf("Expected target_reps_min to remain 8, got %d", ex.TargetRepsMin)
	}
	if ex.TargetWeightKg == nil || *ex.TargetWeightKg != 60.0 {
		t.Errorf("Expected target_weight_kg to remain 60, got %v", ex.TargetWeightKg)
	}
}

func TestHandleAddExerciseToSession_PropagatesWeightToSchedule(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	userID := int64(123456)
	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		allowedUserID: userID,
	}

	group, err := db.CreateWorkoutGroup("Push", "Push day", false, userID, "[1,2,3,4,5]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	rotOrder := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Day A", &rotOrder, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}
	origWeight := 50.0
	exercise, err := db.AddExerciseToVariant(variant.ID, "OHP", 3, 5, nil, &origWeight, 0)
	if err != nil {
		t.Fatalf("AddExerciseToVariant: %v", err)
	}

	// In-progress session
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}
	if err := db.StartSession(session.ID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	newWeight := 55.0
	body, _ := json.Marshal(map[string]interface{}{
		"session_id":      session.ID,
		"exercise_id":     exercise.ID,
		"exercise_name":   "OHP",
		"target_sets":     4,
		"target_reps_min": 6,
		"target_weight_kg": newWeight,
		"status":          "completed",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/workout/exercises/log/add", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleAddExerciseToSession(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify schedule was updated
	exercises, _ := db.ListExercisesByVariant(variant.ID)
	if len(exercises) != 1 {
		t.Fatalf("Expected 1 exercise, got %d", len(exercises))
	}
	ex := exercises[0]
	if ex.TargetSets != 4 {
		t.Errorf("Expected target_sets=4, got %d", ex.TargetSets)
	}
	if ex.TargetRepsMin != 6 {
		t.Errorf("Expected target_reps_min=6, got %d", ex.TargetRepsMin)
	}
	if ex.TargetWeightKg == nil || *ex.TargetWeightKg != newWeight {
		t.Errorf("Expected target_weight_kg=%f, got %v", newWeight, ex.TargetWeightKg)
	}
}

func TestHandleAddExerciseToSession_NoPropagate_UserAddedExercise(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	userID := int64(123456)
	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		allowedUserID: userID,
	}

	group, err := db.CreateWorkoutGroup("Push", "Push day", false, userID, "[1,2,3,4,5]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	rotOrder := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Day A", &rotOrder, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}
	origWeight := 50.0
	exercise, err := db.AddExerciseToVariant(variant.ID, "Bench Press", 3, 8, nil, &origWeight, 0)
	if err != nil {
		t.Fatalf("AddExerciseToVariant: %v", err)
	}

	// In-progress session
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}
	if err := db.StartSession(session.ID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Add a user exercise (exercise_id=99999 doesn't belong to variant)
	body, _ := json.Marshal(map[string]interface{}{
		"session_id":      session.ID,
		"exercise_id":     99999,
		"exercise_name":   "Curls",
		"target_sets":     3,
		"target_reps_min": 12,
		"status":          "completed",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/workout/exercises/log/add", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleAddExerciseToSession(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify original exercise schedule was NOT modified
	exercises, _ := db.ListExercisesByVariant(variant.ID)
	if len(exercises) != 1 {
		t.Fatalf("Expected 1 exercise, got %d", len(exercises))
	}
	ex := exercises[0]
	if ex.ID != exercise.ID {
		t.Errorf("Expected exercise ID %d, got %d", exercise.ID, ex.ID)
	}
	if ex.TargetSets != 3 || ex.TargetRepsMin != 8 {
		t.Errorf("Expected original sets=3, reps=8; got sets=%d, reps=%d", ex.TargetSets, ex.TargetRepsMin)
	}
	if ex.TargetWeightKg == nil || *ex.TargetWeightKg != origWeight {
		t.Errorf("Expected target_weight_kg=%f, got %v", origWeight, ex.TargetWeightKg)
	}
}

func intPtr(v int) *int { return &v }

func TestGetWorkoutStats(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	srv := &Server{
		workouts:      db,
		workoutSvc:    workoutsvc.New(db),
		allowedUserID: 123,
	}

	// Create test user implicitly by adding group
	userID := int64(123)

	group, err := db.CreateWorkoutGroup("Test Group", "Desc", false, userID, "[1,3,5]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create group: %v", err)
	}

	variant, err := db.CreateWorkoutVariant(group.ID, "Main", nil, "")
	if err != nil {
		t.Fatalf("Failed to create variant: %v", err)
	}

	now := time.Now()
	// Create sessions that reflect some activity
	for i := 0; i < 3; i++ {
		date := now.AddDate(0, 0, -i*7) // weekly sessions
		session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, date, "09:00")
		if err != nil {
			t.Fatalf("Failed to create session: %v", err)
		}

		err = db.UpdateSessionStatus(session.ID, "started")
		if err != nil {
			t.Fatalf("Failed to update status: %v", err)
		}
		err = srv.workoutSvc.CompleteSession(session.ID)
		if err != nil {
			t.Fatalf("Failed to complete session: %v", err)
		}
	}

	req := httptest.NewRequest("GET", "/api/workout/stats", nil)
	// We need to set the user context manually
	req = withUser(req, 123)
	w := httptest.NewRecorder()

	srv.handleGetWorkoutStats(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var stats map[string]interface{}
	err = json.Unmarshal(w.Body.Bytes(), &stats)
	if err != nil {
		t.Fatalf("Failed to parse JSON response: %v", err)
	}

	// Verify new stats are present
	if _, ok := stats["active_weeks"]; !ok {
		t.Errorf("Expected 'active_weeks' in response, got: %v", stats)
	}

	// Verify active weeks count is 3 (based on loop)
	if activeWeeks, ok := stats["active_weeks"].(float64); ok {
		if activeWeeks != 3 {
			t.Errorf("Expected active_weeks to be 3, got %f", activeWeeks)
		}
	} else {
		t.Errorf("active_weeks was not a float64: %v", stats["active_weeks"])
	}

	// Verify streak metrics and total_volume_kg are absent
	for _, field := range []string{"current_streak", "longest_streak", "total_volume_kg"} {
		if _, ok := stats[field]; ok {
			t.Errorf("Expected '%s' to be absent from response", field)
		}
	}
}
