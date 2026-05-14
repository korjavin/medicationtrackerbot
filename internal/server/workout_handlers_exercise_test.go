package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleGetUniqueExercises(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	srv := &Server{workouts: db.Workout, allowedUserID: 123456}
	userID := int64(123456)

	// Create group and variant
	group, _ := db.Workout.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.Workout.CreateWorkoutVariant(group.ID, "Variant", nil, "")

	db.Workout.AddExerciseToVariant(variant.ID, "Pushups", 3, 10, nil, nil, 0)
	db.Workout.AddExerciseToVariant(variant.ID, "Squats", 3, 10, nil, nil, 1)

	req := withUser(httptest.NewRequest(http.MethodGet, "/api/workout/exercises/unique", nil), userID)
	w := httptest.NewRecorder()
	srv.handleGetUniqueExercises(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected 200, got %d", w.Code)
	}
}

func TestHandleAddExerciseToSession(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	srv := &Server{workouts: db.Workout, allowedUserID: 123456}
	userID := int64(123456)
	otherUserID := int64(999999)

	// Setup
	group, _ := db.Workout.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.Workout.CreateWorkoutVariant(group.ID, "Variant", nil, "")
	ex, _ := db.Workout.AddExerciseToVariant(variant.ID, "Burpees", 3, 10, nil, nil, 0)
	session, _ := db.Workout.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

	// Setup other user session
	group2, _ := db.Workout.CreateWorkoutGroup("Group 2", "Desc", false, otherUserID, "[]", "10:00", 15)
	variant2, _ := db.Workout.CreateWorkoutVariant(group2.ID, "Variant 2", nil, "")
	session2, _ := db.Workout.CreateWorkoutSession(group2.ID, variant2.ID, otherUserID, time.Now(), "10:00")

	// Test adding exercise - Success
	payload := map[string]interface{}{
		"session_id":       session.ID,
		"exercise_id":      ex.ID,
		"exercise_name":    "Burpees",
		"target_sets":      5,
		"target_reps_min":  20,
		"target_weight_kg": 0,
		"status":           "completed",
		"notes":            "Extra hard",
	}
	body, _ := json.Marshal(payload)
	req := withUser(httptest.NewRequest(http.MethodPost, "/api/workout/sessions/logs/create", bytes.NewReader(body)), userID)
	w := httptest.NewRecorder()

	srv.handleAddExerciseToSession(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("Expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Test adding exercise - Forbidden (wrong user)
	payloadForbidden := map[string]interface{}{
		"session_id":      session2.ID, // Owned by otherUserID
		"exercise_id":     ex.ID,
		"exercise_name":   "Burpees",
		"target_sets":     5,
		"target_reps_min": 20,
		"status":          "completed",
	}
	bodyForbidden, _ := json.Marshal(payloadForbidden)
	reqForbidden := withUser(httptest.NewRequest(http.MethodPost, "/api/workout/sessions/logs/create", bytes.NewReader(bodyForbidden)), userID)
	wForbidden := httptest.NewRecorder()

	srv.handleAddExerciseToSession(wForbidden, reqForbidden)

	if wForbidden.Code != http.StatusForbidden {
		t.Errorf("Expected 403 Forbidden, got %d. Body: %s", wForbidden.Code, wForbidden.Body.String())
	}
}
