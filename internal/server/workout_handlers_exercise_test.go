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

	srv := &Server{store: db, allowedUserID: 123456}
	userID := int64(123456)

	// Create group and variant
	group, _ := db.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant", nil, "")

	db.AddExerciseToVariant(variant.ID, "Pushups", 3, 10, nil, nil, 0)
	db.AddExerciseToVariant(variant.ID, "Squats", 3, 10, nil, nil, 1)

	req := httptest.NewRequest(http.MethodGet, "/api/workout/exercises/unique", nil)
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

	srv := &Server{store: db, allowedUserID: 123456}
	userID := int64(123456)
	otherUserID := int64(999999)

	// Setup
	group, _ := db.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant", nil, "")
	ex, _ := db.AddExerciseToVariant(variant.ID, "Burpees", 3, 10, nil, nil, 0)
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

	// Setup other user session
	group2, _ := db.CreateWorkoutGroup("Group 2", "Desc", false, otherUserID, "[]", "10:00", 15)
	variant2, _ := db.CreateWorkoutVariant(group2.ID, "Variant 2", nil, "")
	session2, _ := db.CreateWorkoutSession(group2.ID, variant2.ID, otherUserID, time.Now(), "10:00")

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
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/logs/create", bytes.NewReader(body))
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
	reqForbidden := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/logs/create", bytes.NewReader(bodyForbidden))
	wForbidden := httptest.NewRecorder()

	srv.handleAddExerciseToSession(wForbidden, reqForbidden)

	if wForbidden.Code != http.StatusForbidden {
		t.Errorf("Expected 403 Forbidden, got %d. Body: %s", wForbidden.Code, wForbidden.Body.String())
	}
}
