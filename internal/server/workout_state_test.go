package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleDeleteExerciseLog(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	srv := &Server{workouts: db, allowedUserID: 123456}
	userID := int64(123456)

	// Setup
	group, _ := db.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant", nil, "")
	ex, _ := db.AddExerciseToVariant(variant.ID, "Pushups", 3, 10, nil, nil, 0)
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

	// Create a log
	sets := 3
	reps := 10
	logID, _ := db.LogExercise(session.ID, ex.ID, "Pushups", &sets, &reps, nil, "completed", "")

	// Verify log exists
	logs, _ := db.GetExerciseLogs(session.ID)
	if len(logs) != 1 {
		t.Fatalf("Expected 1 log, got %d", len(logs))
	}

	// Test: Delete the log
	req := withUser(httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/workout/sessions/logs/delete?id=%d", logID), nil), userID)
	w := httptest.NewRecorder()
	srv.handleDeleteExerciseLog(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify log is gone
	logs, _ = db.GetExerciseLogs(session.ID)
	if len(logs) != 0 {
		t.Fatalf("Expected 0 logs after delete, got %d", len(logs))
	}

	// Test: Delete non-existent log (should still return 200 — idempotent)
	req2 := withUser(httptest.NewRequest(http.MethodDelete, "/api/workout/sessions/logs/delete?id=99999", nil), userID)
	w2 := httptest.NewRecorder()
	srv.handleDeleteExerciseLog(w2, req2)
	if w2.Code != http.StatusOK {
		t.Errorf("Expected 200 for non-existent log, got %d", w2.Code)
	}

	// Test: Invalid ID
	req3 := withUser(httptest.NewRequest(http.MethodDelete, "/api/workout/sessions/logs/delete?id=abc", nil), userID)
	w3 := httptest.NewRecorder()
	srv.handleDeleteExerciseLog(w3, req3)
	if w3.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for invalid ID, got %d", w3.Code)
	}
}

func TestExerciseLogIdempotency(t *testing.T) {
	// This test verifies that only explicitly logged exercises are saved, and updates do not duplicate logs.
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant", nil, "")
	ex1, _ := db.AddExerciseToVariant(variant.ID, "Dead Bug", 2, 10, nil, nil, 0)
	ex2, _ := db.AddExerciseToVariant(variant.ID, "Overhead Press", 4, 6, nil, nil, 1)
	ex3, _ := db.AddExerciseToVariant(variant.ID, "Push-ups", 3, 10, nil, nil, 2)
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")
	_ = db.StartSession(session.ID)

	// Simulate: TG bot logs exercise 1 (Done)
	sets1, reps1 := 2, 10
	_, _ = db.LogExercise(session.ID, ex1.ID, "Dead Bug", &sets1, &reps1, nil, "completed", "")

	// Simulate: Web opens session, user edits exercise 2 only (not exercise 3)
	sets2, reps2 := 4, 6
	weight2 := 30.0
	_, _ = db.LogExercise(session.ID, ex2.ID, "Overhead Press", &sets2, &reps2, &weight2, "completed", "")

	// Verify: Only 2 logs exist (not 3) — exercise 3 was NOT saved
	logs, _ := db.GetExerciseLogs(session.ID)
	if len(logs) != 2 {
		t.Fatalf("Expected 2 logs (only explicitly saved), got %d", len(logs))
	}

	// Verify exercise 3 lookup returns nil
	log3, _ := db.GetExerciseLogBySessionAndExercise(session.ID, ex3.ID)
	if log3 != nil {
		t.Fatal("Exercise 3 should NOT have a log — it was not saved")
	}

	// Now TG bot clicks Done on exercise 2 — should find existing and update, not duplicate
	existing, _ := db.GetExerciseLogBySessionAndExercise(session.ID, ex2.ID)
	if existing == nil {
		t.Fatal("Expected existing log for exercise 2")
	}

	// TG bot updates it (idempotent)
	_ = db.UpdateExerciseLog(existing.ID, &sets2, &reps2, &weight2, "")

	// Still only 2 logs
	logs, _ = db.GetExerciseLogs(session.ID)
	if len(logs) != 2 {
		t.Fatalf("Expected still 2 logs (no duplicate from TG bot), got %d", len(logs))
	}

	// Now TG bot clicks Done on exercise 3
	existingEx3, _ := db.GetExerciseLogBySessionAndExercise(session.ID, ex3.ID)
	if existingEx3 != nil {
		t.Fatal("Exercise 3 should not have a log yet")
	}
	sets3, reps3 := 3, 10
	_, _ = db.LogExercise(session.ID, ex3.ID, "Push-ups", &sets3, &reps3, nil, "completed", "")

	// Now 3 logs — all exercises completed
	logs, _ = db.GetExerciseLogs(session.ID)
	if len(logs) != 3 {
		t.Fatalf("Expected 3 logs (all exercises done), got %d", len(logs))
	}

	// Verify exercise names
	names := make(map[string]bool)
	for _, l := range logs {
		names[l.ExerciseName] = true
	}
	for _, expected := range []string{"Dead Bug", "Overhead Press", "Push-ups"} {
		if !names[expected] {
			t.Errorf("Missing exercise %q in logs", expected)
		}
	}

	_ = json.NewEncoder // suppress unused import
}
